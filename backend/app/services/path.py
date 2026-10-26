"""Flexible knowledge graph: a personal route per learner on top of the author's graph.

The author's edges are hard prerequisites. After every finished node the AI re-plans the route:
priority order of the remaining nodes, a mode per node (fast / standard / deep) and, when a gap
blocks progress, an optional personal "bridge" node visible only to this learner.
"""

import logging
import re
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import memory
from ..db import SessionLocal
from ..llm import get_llm
from ..models import Course, ExamAttempt, GraphEdge, GraphNode, LearnerPath, NodeProgress, User
from ..prompts import PATH_SCHEMA, PATH_SYSTEM
from . import context as ctx

log = logging.getLogger("meraki.path")


def visible_nodes(db: Session, course_id: int, user_id: int) -> list[GraphNode]:
    """The learner's route: the author's topics plus their personal bridges. Side quests are not part of it."""
    return list(
        db.scalars(
            select(GraphNode)
            .where(
                GraphNode.course_id == course_id,
                or_(GraphNode.owner_user_id.is_(None), GraphNode.owner_user_id == user_id),
                GraphNode.kind != "side",
            )
            .order_by(GraphNode.order_index, GraphNode.id)
        ).all()
    )


def side_nodes(db: Session, course_id: int, user_id: int) -> list[GraphNode]:
    """The learner's accepted side quests: dead-end branches drawn on the map, outside the route."""
    return list(
        db.scalars(
            select(GraphNode)
            .where(GraphNode.course_id == course_id, GraphNode.owner_user_id == user_id, GraphNode.kind == "side")
            .order_by(GraphNode.id)
        ).all()
    )


def hard_prereqs(db: Session, course_id: int) -> dict[int, set[int]]:
    prereq: dict[int, set[int]] = {}
    for e in db.scalars(select(GraphEdge).where(GraphEdge.course_id == course_id)).all():
        prereq.setdefault(e.dst_id, set()).add(e.src_id)
    return prereq


def ensure_path(db: Session, user_id: int, course_id: int) -> LearnerPath:
    path = db.scalar(select(LearnerPath).where(LearnerPath.user_id == user_id, LearnerPath.course_id == course_id))
    if path is None:
        path = LearnerPath(user_id=user_id, course_id=course_id, order=[n.id for n in visible_nodes(db, course_id, user_id)])
        db.add(path)
        db.flush()
    return path


def ordered_ids(nodes: list[GraphNode], prereq: dict[int, set[int]], priority: list[int]) -> list[int]:
    """Topological order that follows the AI's priority wherever prerequisites allow (Kahn's algorithm)."""
    ids = [n.id for n in nodes]
    rank = {nid: i for i, nid in enumerate(priority)}
    fallback = {n.id: len(priority) + i for i, n in enumerate(nodes)}
    key = lambda nid: rank.get(nid, fallback[nid])  # noqa: E731
    remaining = set(ids)
    result: list[int] = []
    while remaining:
        ready = [nid for nid in remaining if not (prereq.get(nid, set()) & remaining)]
        if not ready:  # cycle guard: should not happen, the builder breaks cycles
            ready = list(remaining)
        nxt = min(ready, key=key)
        result.append(nxt)
        remaining.discard(nxt)
    return result


ROUTE_DEFAULTS = {"reorder": True, "modes": True, "bridges": True}


def route_settings(course: Course) -> dict[str, bool]:
    """What the author lets the AI change in personal routes (everything by default)."""
    saved = course.route_settings or {}
    return {k: bool(saved.get(k, v)) for k, v in ROUTE_DEFAULTS.items()}


def adventures_enabled(course: Course) -> bool:
    """Whether side quests and random encounters happen in this course (the author can switch them off)."""
    return bool((course.route_settings or {}).get("adventures", True))


def effective_priority(course: Course, nodes: list[GraphNode], path_order: list[int]) -> list[int]:
    """Study priority honouring the author's constraints.

    Author topics follow the AI order (or the author order when reordering is off); pinned topics
    keep their author position; personal bridges stay right before the topic they prepare for.
    Hard prerequisites are applied afterwards by `ordered_ids`.
    """
    settings = route_settings(course)
    author = sorted((n for n in nodes if n.owner_user_id is None), key=lambda n: (n.order_index, n.id))
    by_id = {n.id: n for n in nodes}
    shared_ids = {n.id for n in author}
    if settings["reorder"]:
        base = [nid for nid in path_order if nid in shared_ids]
        base += [n.id for n in author if n.id not in base]
    else:
        base = [n.id for n in author]
    # pinned topics occupy their author slots, the rest fill the gaps in `base` order
    slots: list[int | None] = [n.id if n.pinned else None for n in author]
    free = iter(nid for nid in base if not by_id[nid].pinned)
    shared = [s if s is not None else next(free) for s in slots]
    # bridges: placed before the shared topic that followed them in the stored route
    result = list(shared)
    for i, nid in enumerate(path_order):
        node = by_id.get(nid)
        if node is None or node.owner_user_id is None:
            continue
        target = next((x for x in path_order[i + 1 :] if x in shared_ids), None)
        result.insert(result.index(target) if target in result else len(result), nid)
    result += [n.id for n in nodes if n.id not in result]
    return result


def node_mode(db: Session, user_id: int, node: GraphNode) -> str:
    if node.kind == "side":
        return "side"
    if node.owner_user_id is not None:
        return "bridge"
    course = db.get(Course, node.course_id)
    if course is None or not route_settings(course)["modes"]:
        return "standard"
    path = db.scalar(select(LearnerPath).where(LearnerPath.user_id == user_id, LearnerPath.course_id == node.course_id))
    if path is None:
        return "standard"
    return str((path.modes.get(str(node.id)) or {}).get("mode", "standard"))


def route_view(db: Session, user_id: int, course_id: int) -> dict[str, Any]:
    path = ensure_path(db, user_id, course_id)
    course = db.get(Course, course_id)
    assert course is not None
    nodes = visible_nodes(db, course_id, user_id)
    order = ordered_ids(nodes, hard_prereqs(db, course_id), effective_priority(course, nodes, path.order))
    return {
        "order": order,
        "modes": path.modes if route_settings(course)["modes"] else {},
        "message": path.message,
        "replans": path.replans,
    }


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")[:50] or "bridge"


async def replan(user_id: int, course_id: int) -> None:
    with SessionLocal() as db:
        user, course = db.get(User, user_id), db.get(Course, course_id)
        if user is None or course is None:
            return
        allowed = route_settings(course)
        if not any(allowed.values()):
            return  # the author fixed the route completely: nothing for the AI to decide
        nodes = visible_nodes(db, course_id, user_id)
        prereq = hard_prereqs(db, course_id)
        by_id = {n.id: n for n in nodes}
        progress = {
            p.node_id: p
            for p in db.scalars(
                select(NodeProgress).where(NodeProgress.user_id == user_id, NodeProgress.node_id.in_(list(by_id)))
            ).all()
        }
        lines = []
        for n in nodes:
            p = progress.get(n.id)
            status = "завершена" if p and p.completed else (f"в процессе ({p.stage})" if p else "не начата")
            a = (p.assessment or {}) if p else {}
            reqs = [by_id[r].key for r in prereq.get(n.id, set()) if r in by_id]
            lines.append(
                f"- key={n.key}{' [личная]' if n.owner_user_id else ''}: «{n.title}» — {status}; requires={reqs}; "
                f"понятия: {', '.join(n.concepts)}"
                + (f"; пролог-уровень {a.get('overall_level')}" if a else "")
                + (f"; практика {p.practice_score}, экзамен {p.exam_score}" if p and (p.practice_score or p.exam_score) else "")
            )
        weak = [
            c
            for a in db.scalars(
                select(ExamAttempt).where(ExamAttempt.user_id == user_id, ExamAttempt.node_id.in_(list(by_id)))
            ).all()
            for c in (a.weak_concepts or [])
        ]
        pinned = [n.title for n in nodes if n.pinned and n.owner_user_id is None]
        rules = [
            "менять порядок тем можно" if allowed["reorder"] else "порядок тем задан автором — НЕ меняй его (order верни в текущем порядке)",
            f"эти темы закреплены автором на своих местах: {', '.join(pinned)}" if pinned else "",
            "режимы fast/deep назначать можно" if allowed["modes"] else "режимы назначать нельзя — у всех тем standard",
            "мостовые темы добавлять можно" if allowed["bridges"] else "мостовые темы добавлять нельзя (bridge — пустой список)",
        ]
        prompt = ctx.join_blocks(
            ctx.learner_block(db, user),
            ctx.course_block(course),
            "## Ограничения автора курса\n" + "\n".join(f"- {r}" for r in rules if r),
            "## Граф и прогресс\n" + "\n".join(lines),
            f"## Слабые понятия по экзаменам\n{', '.join(dict.fromkeys(weak)) or 'нет'}",
            ctx.course_history_block(db, user_id, course_id),
        )
    recalled = await memory.recall(user_id, f"{course.title}: трудности, интересы, стиль обучения", limit=4)
    if recalled:
        prompt += "\n\n## Из долговременной памяти (MemPalace)\n" + "\n".join(f"- {r}" for r in recalled)
    try:
        plan = await get_llm().complete_json(system=PATH_SYSTEM, prompt=prompt, schema=PATH_SCHEMA, tier="fast")
    except Exception:
        log.exception("replan failed")
        return

    with SessionLocal() as db:
        path = ensure_path(db, user_id, course_id)
        nodes = visible_nodes(db, course_id, user_id)
        by_key = {n.key: n for n in nodes}
        done = {p.node_id for p in db.scalars(select(NodeProgress).where(NodeProgress.user_id == user_id, NodeProgress.completed.is_(True))).all()}
        if allowed["reorder"]:
            priority = [n.id for n in nodes if n.id in done]
            priority += [by_key[k].id for k in plan.get("order", []) if k in by_key and by_key[k].id not in priority]
        else:
            priority = list(path.order)  # effective_priority() applies the author order anyway

        for b in plan.get("bridge", [])[: 1 if allowed["bridges"] else 0]:
            target = by_key.get(str(b.get("insert_before", "")))
            if target is None or target.id in done:
                continue
            bridge = GraphNode(
                course_id=course_id, owner_user_id=user_id, key=f"bridge_{_slug(str(b.get('title', '')))}",
                title=str(b.get("title", "Мостик"))[:200], summary=f"{b.get('summary', '')}\n\nПочему: {b.get('reason', '')}",
                objectives=[str(x) for x in b.get("objectives", [])][:4], concepts=[str(x) for x in b.get("concepts", [])][:6],
                order_index=target.order_index,
            )  # fmt: skip
            db.add(bridge)
            db.flush()
            idx = priority.index(target.id) if target.id in priority else len(priority)
            priority.insert(idx, bridge.id)

        modes = {}
        for m in plan.get("modes", []) if allowed["modes"] else []:
            node = by_key.get(str(m.get("key", "")))
            if node is not None and m.get("mode") in ("fast", "standard", "deep"):
                modes[str(node.id)] = {"mode": m["mode"], "reason": str(m.get("reason", ""))[:300]}
        path.order = priority
        path.modes = modes
        path.message = str(plan.get("message", ""))[:1500]
        path.replans += 1
        db.commit()
