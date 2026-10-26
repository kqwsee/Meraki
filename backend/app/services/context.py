"""Builds the context blocks every teacher prompt is assembled from."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Course, Enrollment, ExamAttempt, GraphEdge, GraphNode, Message, NodeProgress, User
from ..prompts import DOMAINS, TOOL_CATALOG
from . import custom_tools, materials

MIND_AXES = {
    "engineering": "инженерный",
    "analytical": "аналитико-математический",
    "it": "алгоритмический",
    "natural_science": "естественно-научный",
    "humanities": "гуманитарный",
    "creative": "творческий",
    "practical": "прикладной",
}


def course_progress(db: Session, user_id: int, course_id: int) -> float:
    shared = (GraphNode.course_id == course_id, GraphNode.owner_user_id.is_(None))
    total = db.scalar(select(func.count()).select_from(GraphNode).where(*shared)) or 0
    if not total:
        return 0.0
    done = db.scalar(
        select(func.count())
        .select_from(NodeProgress)
        .join(GraphNode, GraphNode.id == NodeProgress.node_id)
        .where(*shared, NodeProgress.user_id == user_id, NodeProgress.completed.is_(True))
    ) or 0
    return round(100.0 * done / total, 1)


def learner_block(db: Session, user: User) -> str:
    lines = [f"## Ученик\nИмя: {user.name}"]
    if user.mind_profile:
        axes = sorted(user.mind_profile.items(), key=lambda kv: -float(kv[1] or 0))
        lines.append("Склад ума: " + ", ".join(f"{MIND_AXES.get(k, k)} {float(v):.1f}" for k, v in axes))
    lines.append(f"Таланты: {user.talents}" if user.talents else "Таланты: профиль ещё не сформирован (новый ученик).")
    if user.strengths:
        lines.append("Сильные стороны: " + "; ".join(user.strengths))
    if user.growth_areas:
        lines.append("Зоны роста: " + "; ".join(user.growth_areas))
    enrollments = db.scalars(select(Enrollment).where(Enrollment.user_id == user.id)).all()
    if enrollments:
        parts = [f"{e.course.title} ({course_progress(db, user.id, e.course_id):.0f}%)" for e in enrollments]
        lines.append("Курсы: " + ", ".join(parts))
    if user.typing_baseline.get("cpm"):
        lines.append(f"Обычная скорость печати: ~{user.typing_baseline['cpm']:.0f} зн/мин")
    from .integrity import describe_writing

    traits = describe_writing(user.writing_profile or {})
    if traits:
        lines.append("Как пишет: " + "; ".join(traits))
    return "\n".join(lines)


def course_block(course: Course, db: Session | None = None) -> str:
    tools = ", ".join(TOOL_CATALOG.get(t, t) for t in course.tools) or "стандартные"
    own = custom_tools.tools_line(db, course.id) if db is not None else ""
    return (
        f"## Курс\n«{course.title}» — {DOMAINS.get(course.domain, course.domain)}\n"
        f"{course.summary or course.description}\nИнструменты практики: {tools}"
        + (f"\nСвои инструменты автора курса (ученик может ими пользоваться, на них можно строить задания): {own}" if own else "")
    )


def prerequisites(db: Session, node: GraphNode) -> list[GraphNode]:
    src_ids = db.scalars(select(GraphEdge.src_id).where(GraphEdge.dst_id == node.id)).all()
    return list(db.scalars(select(GraphNode).where(GraphNode.id.in_(src_ids))).all()) if src_ids else []


def node_block(db: Session, node: GraphNode) -> str:
    pre = prerequisites(db, node)
    out = [
        f"## Текущая тема: «{node.title}»",
        node.summary,
        "Цели: " + "; ".join(node.objectives),
        "Ключевые понятия: " + ", ".join(node.concepts),
    ]
    if pre:
        out.append("Опирается на темы: " + ", ".join(p.title for p in pre))
    return "\n".join(out)


def assessment_block(progress: NodeProgress) -> str:
    a = progress.assessment or {}
    if not a:
        return ""
    concepts = "; ".join(f"{c['concept']}: {float(c['level']):.1f}" for c in a.get("concepts", []))
    return (
        "## Диагностика пролога\n"
        f"Общий уровень: {float(a.get('overall_level', 0)):.1f}. По понятиям: {concepts}\n"
        f"Заблуждения: {'; '.join(a.get('misconceptions', [])) or 'не выявлены'}\n"
        f"Интересы: {', '.join(a.get('interests', []))}\n"
        f"Стиль мышления: {a.get('thinking_style', '')}\nРекомендуемый подход: {a.get('recommended_approach', '')}"
    )


def memory_block(progress: NodeProgress) -> str:
    return f"## Из долговременной памяти (MemPalace)\n{progress.memory_context}" if progress.memory_context else ""


def materials_block(db: Session, course_id: int, query: str, limit: int = 4, kind: str | None = None) -> str:
    found = materials.search(db, course_id, query, limit=limit, kind=kind)
    if not found:
        return ""
    return "## Выдержки из материалов курса\n" + "\n---\n".join(found)


def history_text(messages: list[Message], max_chars: int = 14000) -> str:
    rendered: list[str] = []
    used = 0
    for m in reversed(messages):
        who = "Ученик" if m.role == "user" else "Наставник"
        piece = f"{who}: {m.content}"
        if used + len(piece) > max_chars:
            break
        rendered.append(piece)
        used += len(piece)
    return "\n\n".join(reversed(rendered))


def stage_messages(db: Session, user_id: int, node_id: int, stage: str) -> list[Message]:
    return list(
        db.scalars(
            select(Message)
            .where(Message.user_id == user_id, Message.node_id == node_id, Message.stage == stage)
            .order_by(Message.id)
        ).all()
    )


def course_history_block(db: Session, user_id: int, course_id: int) -> str:
    """The learner's interaction history in this course, so explanations build on what already happened."""
    rows = db.execute(
        select(GraphNode, NodeProgress)
        .join(NodeProgress, NodeProgress.node_id == GraphNode.id)
        .where(GraphNode.course_id == course_id, NodeProgress.user_id == user_id)
        .order_by(NodeProgress.updated_at)
    ).all()
    if not rows:
        return ""
    lines = ["## История ученика в этом курсе"]
    for node, p in rows:
        a = p.assessment or {}
        parts = [f"«{node.title}»{' (побочный квест по его интересу)' if node.kind == 'side' else ''}: {'пройдена' if p.completed else 'этап ' + p.stage}"]
        if a:
            parts.append(f"стартовый уровень {a.get('overall_level')}, калибровка {a.get('calibration', '?')}")
            if a.get("misconceptions"):
                parts.append("заблуждения: " + "; ".join(a["misconceptions"][:3]))
        if p.practice_score is not None:
            parts.append(f"практика {p.practice_score}")
        if p.exam_score is not None:
            parts.append(f"экзамен {p.exam_score}")
        if p.exit_ticket_feedback:
            parts.append("пересказ: " + p.exit_ticket_feedback[:200])
        weak = db.scalars(select(ExamAttempt.weak_concepts).where(ExamAttempt.user_id == user_id, ExamAttempt.node_id == node.id)).all()
        weak_flat = [c for w in weak for c in (w or [])]
        if weak_flat:
            parts.append("слабые понятия: " + ", ".join(dict.fromkeys(weak_flat)))
        lines.append("- " + "; ".join(parts))
    return "\n".join(lines)


def join_blocks(*blocks: str) -> str:
    return "\n\n".join(b for b in blocks if b)
