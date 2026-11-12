import logging

from sqlalchemy import select

from .. import memory
from ..db import SessionLocal
from ..llm import get_llm
from ..models import Enrollment, ExamAttempt, GraphNode, IntegrityFlag, NodeProgress, ReviewCard, User, utcnow
from ..prompts import PROFILE_SCHEMA, PROFILE_SYSTEM
from . import context as ctx
from . import integrity, talents

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
        # concrete moments ("which topic, which weak card, which flag") so section_notes can name
        # what actually shaped each profile number instead of paraphrasing it
        cards = db.scalars(select(ReviewCard).where(ReviewCard.user_id == user_id)).all()
        flags = db.scalars(
            select(IntegrityFlag)
            .where(IntegrityFlag.user_id == user_id)
            .order_by(IntegrityFlag.created_at.desc())
            .limit(20)
        ).all()
        node_ids = {c.node_id for c in cards} | {f.node_id for f in flags if f.node_id is not None}
        titles = (
            dict(db.execute(select(GraphNode.id, GraphNode.title).where(GraphNode.id.in_(node_ids))).all())
            if node_ids else {}
        )
        if cards:
            reps = sum(c.reps for c in cards)
            lapses = sum(c.lapses for c in cards)
            lines.append(
                f"\n## Повторение (интервальные карточки)\n"
                f"Карточек: {len(cards)}, повторений: {reps}, забываний: {lapses}"
            )
            weakest = sorted((c for c in cards if c.reps), key=lambda c: -(c.lapses / max(c.reps, 1)))[:5]
            for c in weakest:
                lines.append(f"- «{titles.get(c.node_id, '?')}»: повторений {c.reps}, забываний {c.lapses}")
        if flags:
            lines.append("\n## Сигналы самостоятельности (последние)")
            # kind + stage + topic + details (chars, cpm, away_ms) — enough to name the moment
            for f in flags:
                lines.append(
                    f"- {f.kind} на этапе {f.stage}, тема «{titles.get(f.node_id, '?')}», детали: {f.detail}"
                )
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
        old_scores = dict(user.mind_profile or {})
        user.talents = str(result.get("talents", ""))
        user.mind_profile = {k: round(max(0.0, min(1.0, float(v))), 2) for k, v in (result.get("mind_profile") or {}).items()}
        user.strengths = [str(s) for s in result.get("strengths", [])][:6]
        user.growth_areas = [str(s) for s in result.get("growth_areas", [])][:6]
        user.talent_notes = {
            k: str(v).strip()[:800]
            for k, v in (result.get("talent_notes") or {}).items()
            if k in ("engineering", "analytical", "it", "natural_science", "humanities", "creative", "practical")
            and str(v).strip()
        }
        talents.record_profile_scores(db, user, old_scores)
        user.section_notes = {
            k: str(v).strip()[:800]
            for k, v in (result.get("section_notes") or {}).items()
            if k in ("mind", "writing", "meta", "autonomy") and str(v).strip()
        }
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
    # Backfill evidence for recent messages the incremental analyser has not seen yet. Debounced
    # and non-blocking, so the route replan that follows this profile update is not delayed.
    talents.schedule_analysis(user_id, scan_all=True)
