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
        enrollments = db.scalars(select(Enrollment).where(Enrollment.user_id == user_id)).all()
        lines = [ctx.learner_block(db, user)]
        if enrollments:
            lines.append("\n## Курсы ученика (для сопоставления фактов)\n" + "\n".join(f"{i + 1}. {e.course.title}" for i, e in enumerate(enrollments)))
        for e in enrollments:
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

    # memory facts (MemPalace KG), numbered so the model can place each one in a course for the knowledge-map graph
    facts = await memory.facts(user_id)
    kept: list[tuple[str, str]] = []
    for f in facts:
        predicate = str(f.get("predicate") or f.get("relation") or "")
        obj = str(f.get("object") or f.get("target") or "")
        if obj:
            kept.append((predicate, obj))
    if kept:
        lines.append("\n## Факты памяти (нумерация для сопоставления)\n" + "\n".join(f"{i + 1}. {p}: {o}" for i, (p, o) in enumerate(kept)))

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
        course_by_title = {
            e.course.title.strip().lower(): e.course_id
            for e in db.scalars(select(Enrollment).where(Enrollment.user_id == user_id)).all()
        }
        clusters: dict[str, int] = {}
        for item in result.get("fact_courses") or []:
            try:
                idx = int(item.get("index", 0)) - 1
            except (TypeError, ValueError):
                continue
            if not (0 <= idx < len(kept)):
                continue
            course_id = course_by_title.get(str(item.get("course", "")).strip().lower())
            if course_id:
                predicate, obj = kept[idx]
                clusters[f"{predicate}:{obj}"[:300]] = course_id
        user.fact_clusters = clusters
        user.profile_updated_at = utcnow()
        db.commit()
    await memory.remember(user_id, "profile", f"Профиль обновлён: {result.get('talents', '')}")
