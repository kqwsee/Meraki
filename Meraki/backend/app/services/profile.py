import logging

from sqlalchemy import select

from .. import memory
from ..db import SessionLocal
from ..llm import get_llm
from ..models import Enrollment, ExamAttempt, GraphNode, NodeProgress, User, utcnow
from ..prompts import PROFILE_SCHEMA, PROFILE_SYSTEM
from . import context as ctx
from . import integrity

log = logging.getLogger("meraki.profile")


async def update_profile(user_id: int) -> None:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        lines = [ctx.learner_block(db, user)]
        for e in db.scalars(select(Enrollment).where(Enrollment.user_id == user_id)).all():
            lines.append(f"\n### Курс «{e.course.title}» ({e.course.domain}), пройдено {ctx.course_progress(db, user_id, e.course_id)}%")
            rows = db.execute(
                select(GraphNode, NodeProgress)
                .join(NodeProgress, NodeProgress.node_id == GraphNode.id)
                .where(GraphNode.course_id == e.course_id, NodeProgress.user_id == user_id)
            ).all()
            for node, p in rows:
                a = p.assessment or {}
                lines.append(
                    f"- «{node.title}»: этап {p.stage}, пролог-уровень {a.get('overall_level', '?')}, "
                    f"стиль: {a.get('thinking_style', '—')}, интересы: {', '.join(a.get('interests', []))}, "
                    f"практика {p.practice_score}, экзамен {p.exam_score}"
                )
        for att in db.scalars(select(ExamAttempt).where(ExamAttempt.user_id == user_id, ExamAttempt.status == "finished")).all():
            if att.understanding is not None:
                lines.append(f"- Проверка понимания после экзамена: {att.understanding:.2f}")
        stats = integrity.user_stats(db, user)
        lines.append(f"\n## Самостоятельность и ввод\n{stats}")
    recalled = await memory.recall(user_id, "сильные стороны, трудности, интересы, стиль мышления ученика", limit=6)
    if recalled:
        lines.append("\n## Долговременная память\n" + "\n".join(f"- {r}" for r in recalled))
    try:
        result = await get_llm().complete_json(system=PROFILE_SYSTEM, prompt="\n".join(lines), schema=PROFILE_SCHEMA, tier="fast")
    except Exception:
        log.exception("profile update failed")
        return
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        user.talents = str(result.get("talents", ""))
        user.mind_profile = {k: round(max(0.0, min(1.0, float(v))), 2) for k, v in (result.get("mind_profile") or {}).items()}
        user.strengths = [str(s) for s in result.get("strengths", [])][:6]
        user.growth_areas = [str(s) for s in result.get("growth_areas", [])][:6]
        user.profile_updated_at = utcnow()
        db.commit()
    await memory.remember(user_id, "profile", f"Профиль обновлён: {result.get('talents', '')}")
