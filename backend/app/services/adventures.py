"""The game layer of the knowledge graph: side quests and random encounters.

All of it lives next to the author's graph and never inside it: nothing here unlocks a topic, counts in the
course progress or reaches the leaderboard (those only look at the author's topics).

- side quest   — a dead-end personal topic ("extra material") offered when the learner showed real curiosity.
                 Once accepted it becomes a personal GraphNode (kind "side") with a short path: lecture -> one challenge.
- recall       — an old, passed topic comes back for a 2-question mini-challenge (feeds the spaced-repetition cards).
- bridge       — a short explainer clarifying the link between a passed topic and the upcoming one.

Rolling happens once per first-time passed author topic (`roll_after_pass`). Pacing constants are right below.
"""

import logging
import random
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import memory
from ..background import spawn
from ..db import SessionLocal
from ..llm import get_llm
from ..models import Adventure, Course, ExamAttempt, GraphNode, Message, Note, NodeProgress, ReviewCard, User, utcnow
from ..prompts import (
    ADVENTURE_BRIDGE_SCHEMA,
    ADVENTURE_BRIDGE_SYSTEM,
    ADVENTURE_GRADE_SCHEMA,
    ADVENTURE_GRADE_SYSTEM,
    ADVENTURE_RECALL_SCHEMA,
    ADVENTURE_RECALL_SYSTEM,
    ADVENTURE_SCOUT_SCHEMA,
    ADVENTURE_SCOUT_SYSTEM,
)
from . import context as ctx
from . import path as route
from . import reviews

log = logging.getLogger("meraki.adventures")

# Pacing: "not too often, on average". A new adventure needs at least MIN_GAP topics passed since the previous
# one; then the chance grows with every further topic and is certain from the fourth (about one per 2-3 topics).
MIN_GAP = 2
CHANCE_BY_GAP = {2: 0.4, 3: 0.7}
MAX_OPEN = 2  # unanswered adventures on the map at once
KIND_WEIGHTS = {"side": 35.0, "recall": 40.0, "bridge": 25.0}
TTL_DAYS = {"side": 21, "recall": 7, "bridge": 7}  # an ignored one leaves the map after this long
SIDE_PASS_SCORE = 50.0  # the closing challenge of a side quest
SIDE_TASKS = 1
RECALL_PASS_SCORE = 60.0
KINDS = ("side", "recall", "bridge")


def _slug(value: str) -> str:
    import re

    return re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")[:40] or "quest"


# ---------- queries ----------


def passed_topics(db: Session, user_id: int, course_id: int) -> list[tuple[GraphNode, NodeProgress]]:
    """The author's topics the learner has passed: the only ones that count as course progress."""
    return list(
        db.execute(
            select(GraphNode, NodeProgress)
            .join(NodeProgress, NodeProgress.node_id == GraphNode.id)
            .where(
                GraphNode.course_id == course_id,
                GraphNode.owner_user_id.is_(None),
                NodeProgress.user_id == user_id,
                NodeProgress.completed.is_(True),
            )
            .order_by(NodeProgress.updated_at)
        ).all()
    )


def _is_blocking(a: Adventure) -> bool:
    # an unanswered offer, or an encounter already started but not finished; a side quest in progress blocks nothing
    return a.status == "offered" or (a.status == "active" and a.kind != "side")


def expire_stale(db: Session, user_id: int, course_id: int) -> None:
    now = utcnow()
    for a in db.scalars(
        select(Adventure).where(Adventure.user_id == user_id, Adventure.course_id == course_id, Adventure.status.in_(("offered", "active")))
    ).all():
        if a.kind == "side" and a.status == "active":
            continue  # accepted quests wait as long as the learner needs
        if now - a.created_at > timedelta(days=TTL_DAYS.get(a.kind, 7)):
            a.status, a.resolved_at = "expired", now


def adventure_json(a: Adventure, include_evidence: bool = True) -> dict[str, Any]:
    return {
        "id": a.id, "kind": a.kind, "status": a.status, "title": a.title, "teaser": a.teaser,
        "evidence": (a.payload or {}).get("evidence", "") if include_evidence and a.kind == "side" else "",
        "anchor_id": a.anchor_id, "topic_id": a.topic_id, "node_id": a.node_id,
        "score": (a.result or {}).get("score"), "created_at": a.created_at.isoformat(),
    }  # fmt: skip


def course_view(db: Session, user_id: int, course: Course) -> dict[str, Any]:
    """What the course page draws on the map and in the adventure panel."""
    expire_stale(db, user_id, course.id)
    rows = list(
        db.scalars(select(Adventure).where(Adventure.user_id == user_id, Adventure.course_id == course.id).order_by(Adventure.id)).all()
    )
    shown = [a for a in rows if a.status in ("offered", "active")]
    finished = [a for a in rows if a.status == "done"]
    return {
        "enabled": route.adventures_enabled(course),
        "items": [adventure_json(a) for a in shown + finished[-6:]],
        "stats": {
            "side_done": sum(a.kind == "side" for a in finished),
            "encounters_done": sum(a.kind != "side" for a in finished),
        },
    }


# ---------- rolling ----------


def _pick_order(weights: dict[str, float], rng: random.Random) -> list[str]:
    """Weighted random order of the kinds to try (without repeats)."""
    pool = dict(weights)
    order: list[str] = []
    while pool:
        r, acc = rng.uniform(0, sum(pool.values())), 0.0
        for kind, w in pool.items():
            acc += w
            if r <= acc:
                order.append(kind)
                del pool[kind]
                break
        else:
            order.append(pool.popitem()[0])
    return order


def _weak_concepts(db: Session, user_id: int, node_id: int) -> list[str]:
    weak = db.scalars(select(ExamAttempt.weak_concepts).where(ExamAttempt.user_id == user_id, ExamAttempt.node_id == node_id)).all()
    return list(dict.fromkeys(c for w in weak for c in (w or [])))


def _recall_pick(db: Session, user_id: int, course_id: int, exclude: set[int], rng: random.Random) -> GraphNode | None:
    """An old topic worth meeting again: long unseen, shaky on exams, lapsed or overdue cards; rarely the same one twice."""
    now = utcnow()
    scored: list[tuple[GraphNode, float]] = []
    for node, p in passed_topics(db, user_id, course_id):
        if node.id in exclude:
            continue
        cards = db.scalars(select(ReviewCard).where(ReviewCard.user_id == user_id, ReviewCard.node_id == node.id)).all()
        lapses = sum(c.lapses for c in cards)
        due = sum(c.due_at <= now for c in cards)
        met = db.scalar(
            select(func.count()).select_from(Adventure).where(Adventure.user_id == user_id, Adventure.kind == "recall", Adventure.topic_id == node.id)
        ) or 0
        weight = 1 + (now - p.updated_at).days * 0.4 + 3 * lapses + 1.5 * due + 2 * len(_weak_concepts(db, user_id, node.id))
        weight += max(0.0, 80 - (p.exam_score if p.exam_score is not None else 80)) / 15
        scored.append((node, weight / (1 + 2 * met)))
    if not scored:
        return None
    return rng.choices([n for n, _ in scored], weights=[w for _, w in scored])[0]


def _bridge_pair(db: Session, user_id: int, course: Course, just_passed: GraphNode) -> tuple[GraphNode, GraphNode] | None:
    """(passed topic, upcoming topic) whose link is worth clarifying; the upcoming one is where the route goes next."""
    view = route.route_view(db, user_id, course.id)
    nodes = {n.id: n for n in route.visible_nodes(db, course.id, user_id)}
    done = {n.id for n, _ in passed_topics(db, user_id, course.id)}
    prereq = route.hard_prereqs(db, course.id)
    target = next(
        (nodes[i] for i in view["order"] if i in nodes and i not in done and nodes[i].owner_user_id is None and prereq.get(i, set()) <= done),
        None,
    )
    if target is None:
        return None
    progress = {n.id: p for n, p in passed_topics(db, user_id, course.id)}
    sources = [nodes[i] for i in prereq.get(target.id, set()) if i in done and i in nodes]
    source = min(sources, key=lambda n: progress[n.id].exam_score if progress[n.id].exam_score is not None else 100) if sources else just_passed
    met = db.scalar(
        select(func.count()).select_from(Adventure).where(
            Adventure.user_id == user_id, Adventure.kind == "bridge", Adventure.topic_id == source.id, Adventure.anchor_id == target.id
        )
    )
    return None if met else (source, target)


async def roll_after_pass(user_id: int, node_id: int, *, force: bool = False, rng: random.Random | None = None) -> int | None:
    """Maybe puts something on the learner's map right after they passed a topic for the first time.

    Returns the new adventure's id. `force` skips the pacing (dev tool and tests), not the "is anything possible" checks.
    """
    rng = rng or random.Random()
    try:
        return await _roll(user_id, node_id, force, rng)
    except Exception:
        log.exception("adventure roll failed")
        return None


async def _roll(user_id: int, node_id: int, force: bool, rng: random.Random) -> int | None:
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        if node is None or node.owner_user_id is not None or node.kind != "topic":
            return None
        course = db.get(Course, node.course_id)
        if course is None or not route.adventures_enabled(course):
            return None
        expire_stale(db, user_id, course.id)
        passed = len(passed_topics(db, user_id, course.id))
        rows = db.scalars(select(Adventure).where(Adventure.user_id == user_id, Adventure.course_id == course.id).order_by(Adventure.id)).all()
        since = passed - (rows[-1].after_passed if rows else 0)
        open_now = [a for a in rows if _is_blocking(a)]
        if not force and (since < MIN_GAP or len(open_now) >= MAX_OPEN or rng.random() >= CHANCE_BY_GAP.get(since, 1.0)):
            db.commit()
            return None

        weights = dict(KIND_WEIGHTS)
        for a in open_now:  # one unanswered adventure of a kind is enough
            weights.pop(a.kind, None)
        recall_node = _recall_pick(db, user_id, course.id, {node.id}, rng) if "recall" in weights else None
        if recall_node is None:
            weights.pop("recall", None)
        pair = _bridge_pair(db, user_id, course, node) if "bridge" in weights else None
        if pair is None:
            weights.pop("bridge", None)
        scout_prompt = _scout_prompt(db, user_id, node, course) if "side" in weights else ""
        weak_of_recall = _weak_concepts(db, user_id, recall_node.id) if recall_node else []
        db.commit()

    for kind in _pick_order(weights, rng):
        if kind == "side":
            draft = await _scout(scout_prompt)
            if draft is None:
                continue
            with SessionLocal() as db:
                a = Adventure(
                    user_id=user_id, course_id=course.id, kind="side", anchor_id=node.id, topic_id=node.id, title=draft["title"],
                    teaser=draft["teaser"], payload=draft, after_passed=passed,
                )  # fmt: skip
                db.add(a)
                db.commit()
                return a.id
        with SessionLocal() as db:
            if kind == "recall" and recall_node is not None:
                weak = weak_of_recall[0] if weak_of_recall else ""
                teaser = rng.choice(
                    [f"Тема «{recall_node.title}» снова встретилась на пути — две быстрых проверки, что она с тобой."]
                    + ([f"Давно не виделись с «{recall_node.title}», а «{weak}» в прошлый раз давалось непросто."] if weak else [])
                )
                a = Adventure(
                    user_id=user_id, course_id=course.id, kind="recall", anchor_id=recall_node.id, topic_id=recall_node.id,
                    title=f"Старый знакомый: «{recall_node.title}»", teaser=teaser, after_passed=passed,
                )  # fmt: skip
            elif kind == "bridge" and pair is not None:
                src, dst = pair
                a = Adventure(
                    user_id=user_id, course_id=course.id, kind="bridge", anchor_id=dst.id, topic_id=src.id,
                    title=f"Мостик: «{src.title}» → «{dst.title}»",
                    teaser=f"Короткое пояснение, как идеи «{src.title}» пригодятся в «{dst.title}».", after_passed=passed,
                )  # fmt: skip
            else:
                continue
            db.add(a)
            db.commit()
            return a.id
    return None


def _scout_prompt(db: Session, user_id: int, node: GraphNode, course: Course) -> str:
    user = db.get(User, user_id)
    assert user is not None
    progress = db.scalar(select(NodeProgress).where(NodeProgress.user_id == user_id, NodeProgress.node_id == node.id))
    said = [
        m.content.strip().replace("\n", " ")[:280]
        for m in db.scalars(
            select(Message).where(Message.user_id == user_id, Message.node_id == node.id, Message.role == "user").order_by(Message.id)
        ).all()
    ][-14:]
    notes = [n.title for n in db.scalars(select(Note).where(Note.user_id == user_id, Note.node_id == node.id)).all()]
    offered = [
        f"{a.title} ({'принят' if a.node_id else 'отклонён' if a.status == 'dismissed' else 'без ответа'})"
        for a in db.scalars(select(Adventure).where(Adventure.user_id == user_id, Adventure.course_id == course.id, Adventure.kind == "side")).all()
    ]
    titles = [n.title for n in db.scalars(select(GraphNode).where(GraphNode.course_id == course.id, GraphNode.owner_user_id.is_(None))).all()]
    return ctx.join_blocks(
        ctx.learner_block(db, user),
        ctx.course_block(course, db),
        ctx.node_block(db, node),
        ctx.assessment_block(progress) if progress else "",
        "## Что ученик писал наставнику по этой теме (его реплики)\n" + "\n".join(f"- {s}" for s in said) if said else "",
        ("## Заметки, которые он сохранил\n" + "\n".join(f"- {t}" for t in notes)) if notes else "",
        (f"## Пересказ ученика после лекции\n{progress.exit_ticket[:600]}") if progress and progress.exit_ticket else "",
        "## Темы курса (квест не должен их дублировать)\n" + ", ".join(titles),
        ("## Уже предлагалось\n" + "\n".join(f"- {o}" for o in offered)) if offered else "",
    )


async def _scout(prompt: str) -> dict[str, Any] | None:
    result = await get_llm().complete_json(system=ADVENTURE_SCOUT_SYSTEM, prompt=prompt, schema=ADVENTURE_SCOUT_SCHEMA, tier="fast")
    title, teaser = str(result.get("title", "")).strip()[:200], str(result.get("teaser", "")).strip()
    evidence = str(result.get("evidence", "")).strip()
    if not result.get("found") or not title or not teaser or not evidence:
        return None  # no concrete sign of interest: no quest
    return {
        "title": title, "teaser": teaser, "evidence": evidence[:400], "summary": str(result.get("summary", "")).strip(),
        "objectives": [str(x) for x in result.get("objectives", [])][:4], "concepts": [str(x) for x in result.get("concepts", [])][:6],
    }  # fmt: skip


# ---------- side quests ----------


def accept_side(db: Session, user_id: int, adv: Adventure) -> GraphNode:
    """Turns an offer into the learner's personal dead-end topic; returns it (created once)."""
    if adv.node_id:
        node = db.get(GraphNode, adv.node_id)
        if node is not None:
            return node
    draft = adv.payload or {}
    parent = db.get(GraphNode, adv.anchor_id) if adv.anchor_id else None
    summary = str(draft.get("summary", "")).strip()
    node = GraphNode(
        course_id=adv.course_id, owner_user_id=user_id, kind="side", parent_id=parent.id if parent else None,
        key=f"side_{_slug(adv.title)}_{adv.id}", title=adv.title[:200],
        summary=summary + (f"\n\nПочему тебе это предложили: {draft['evidence']}" if draft.get("evidence") else ""),
        objectives=list(draft.get("objectives", [])), concepts=list(draft.get("concepts", [])),
        order_index=parent.order_index if parent else 0,
    )  # fmt: skip
    db.add(node)
    db.flush()
    parent_assessment = {}
    if parent is not None:
        p = db.scalar(select(NodeProgress).where(NodeProgress.user_id == user_id, NodeProgress.node_id == parent.id))
        parent_assessment = (p.assessment or {}) if p else {}
    db.add(
        NodeProgress(
            user_id=user_id, node_id=node.id, stage="lecture",
            # no prologue: the learner chose this themself, so the lecture starts from a medium level and their own interest
            assessment={
                "overall_level": min(0.6, max(0.4, float(parent_assessment.get("overall_level", 0.45)))), "concepts": [],
                "misconceptions": [], "pre_questions": [], "interests": [adv.title], "calibration": "unknown",
                "thinking_style": str(parent_assessment.get("thinking_style", "")),
                "recommended_approach": "исследовательский: отталкивайся от интереса ученика, давай неожиданные примеры и вопросы «а что если…»",
            },
        )  # fmt: skip
    )
    adv.node_id, adv.status = node.id, "active"
    db.flush()
    return node


def complete_side(db: Session, user_id: int, node: GraphNode, progress: NodeProgress) -> None:
    """The closing challenge was solved: the quest is done (nothing is recalculated, nothing is unlocked)."""
    progress.completed, progress.stage = True, "done"
    adv = db.scalar(select(Adventure).where(Adventure.user_id == user_id, Adventure.node_id == node.id))
    if adv is not None and adv.status != "done":
        adv.status, adv.resolved_at = "done", utcnow()
        adv.result = {"score": progress.practice_score}
    spawn(_remember_side(user_id, node.course_id, node.title, progress.practice_score))


async def _remember_side(user_id: int, course_id: int, title: str, score: float | None) -> None:
    await memory.remember(
        user_id, f"course_{course_id}", f"Побочный квест «{title}» пройден по собственному интересу (вызов: {score}%).", source="side_quest"
    )
    await memory.add_fact(user_id, "explored", title)


# ---------- encounters ----------

_starting: set[int] = set()


class AdventureError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _owned(db: Session, user_id: int, adventure_id: int) -> Adventure:
    adv = db.get(Adventure, adventure_id)
    if adv is None or adv.user_id != user_id:
        raise AdventureError(404, "Приключение не найдено")
    return adv


async def start_encounter(user_id: int, adventure_id: int) -> None:
    """Generates the content of an encounter the first time the learner takes it (nothing is spent on ignored ones)."""
    if adventure_id in _starting:
        raise AdventureError(409, "Встреча уже готовится")
    with SessionLocal() as db:
        adv = _owned(db, user_id, adventure_id)
        if adv.kind == "side":
            raise AdventureError(400, "Это побочный квест")
        if adv.status not in ("offered", "active"):
            raise AdventureError(409, "Эта встреча уже закончилась")
        if (adv.payload or {}).get("content"):
            return
        user, topic = db.get(User, user_id), db.get(GraphNode, adv.topic_id) if adv.topic_id else None
        course = db.get(Course, adv.course_id)
        if user is None or topic is None or course is None:
            raise AdventureError(409, "Тема встречи удалена")
        progress = db.scalar(select(NodeProgress).where(NodeProgress.user_id == user_id, NodeProgress.node_id == topic.id))
        weak = _weak_concepts(db, user_id, topic.id)
        cards = db.scalars(select(ReviewCard).where(ReviewCard.user_id == user_id, ReviewCard.node_id == topic.id)).all()
        lapsed = [c.question for c in cards if c.lapses][:4]
        misconceptions = ((progress.assessment or {}).get("misconceptions") or [])[:4] if progress else []
        learner = [
            ctx.learner_block(db, user),
            ctx.course_block(course, db),
            ctx.node_block(db, topic),
            f"## Конспект лекции\n{progress.lecture_summary}" if progress and progress.lecture_summary else "",
            ("## Слабые понятия на экзаменах\n" + ", ".join(weak)) if weak else "",
            ("## Заблуждения, найденные в прологе\n" + "; ".join(misconceptions)) if misconceptions else "",
            ("## Вопросы, на которых он ошибался при повторении\n" + "\n".join(f"- {q}" for q in lapsed)) if lapsed else "",
        ]
        if adv.kind == "recall":
            nxt = _next_topic(db, user_id, course)
            learner.append(f"## Что ученик проходит сейчас\n{nxt.title}: {', '.join(nxt.concepts)}" if nxt else "")
            system = ADVENTURE_RECALL_SYSTEM.format(title=topic.title)
            schema = ADVENTURE_RECALL_SCHEMA
        else:
            target = db.get(GraphNode, adv.anchor_id) if adv.anchor_id else None
            if target is None:
                raise AdventureError(409, "Тема встречи удалена")
            learner.append("## Ближайшая тема\n" + ctx.node_block(db, target))
            learner.append(ctx.materials_block(db, course.id, f"{topic.title} {target.title} {' '.join(target.concepts)}", limit=3))
            system = ADVENTURE_BRIDGE_SYSTEM.format(from_title=topic.title, to_title=target.title)
            schema = ADVENTURE_BRIDGE_SCHEMA
        prompt = ctx.join_blocks(*learner)
        kind = adv.kind

    _starting.add(adventure_id)
    try:
        content = await get_llm().complete_json(system=system, prompt=prompt, schema=schema, tier="fast")
    finally:
        _starting.discard(adventure_id)
    if kind == "recall":
        questions = [
            {"id": f"q{i}", "kind": q.get("kind") if q.get("kind") in ("recall", "transfer") else "recall", "question": str(q.get("question", "")).strip(),
             "concept": str(q.get("concept", ""))[:120], "reference": str(q.get("reference", ""))}
            for i, q in enumerate(content.get("questions", [])[:3], start=1) if str(q.get("question", "")).strip()
        ]  # fmt: skip
        if not questions:
            raise AdventureError(502, "Не получилось составить встречу, попробуй ещё раз")
        content = {"intro": str(content.get("intro", "")).strip(), "questions": questions}
    else:
        check = content.get("check") or {}
        if not str(check.get("question", "")).strip() or not str(content.get("explainer", "")).strip():
            raise AdventureError(502, "Не получилось составить мостик, попробуй ещё раз")
        content = {
            "intro": str(content.get("intro", "")).strip(), "explainer": str(content["explainer"]).strip(),
            "concept": str(content.get("concept", ""))[:120],
            "questions": [{"id": "q1", "kind": "check", "question": str(check["question"]).strip(), "concept": str(content.get("concept", ""))[:120],
                           "reference": str(check.get("reference", ""))}],
        }  # fmt: skip
    with SessionLocal() as db:
        adv = _owned(db, user_id, adventure_id)
        adv.payload, adv.status = {**(adv.payload or {}), "content": content}, "active"
        db.commit()


def _next_topic(db: Session, user_id: int, course: Course) -> GraphNode | None:
    view = route.route_view(db, user_id, course.id)
    nodes = {n.id: n for n in route.visible_nodes(db, course.id, user_id)}
    done = {n.id for n, _ in passed_topics(db, user_id, course.id)}
    prereq = route.hard_prereqs(db, course.id)
    return next((nodes[i] for i in view["order"] if i in nodes and i not in done and prereq.get(i, set()) <= done), None)


def encounter_json(db: Session, adv: Adventure) -> dict[str, Any]:
    """Everything the encounter page needs; reference answers appear only once the encounter is over."""
    content = (adv.payload or {}).get("content") or {}
    done = adv.status == "done"
    titles = {n.id: n.title for n in db.scalars(select(GraphNode).where(GraphNode.id.in_([i for i in (adv.topic_id, adv.anchor_id) if i]))).all()}
    return {
        **adventure_json(adv), "course_id": adv.course_id,
        "topic_title": titles.get(adv.topic_id or 0, ""), "target_title": titles.get(adv.anchor_id or 0, "") if adv.kind == "bridge" else "",
        "content": {
            "intro": content.get("intro", ""), "explainer": content.get("explainer", ""), "concept": content.get("concept", ""),
            "questions": [{k: v for k, v in q.items() if k != "reference" or done} for q in content.get("questions", [])],
        } if content else None,
        "result": adv.result if done else None,
    }  # fmt: skip


async def submit_encounter(user_id: int, adventure_id: int, answers: dict[str, str]) -> dict[str, Any]:
    with SessionLocal() as db:
        adv = _owned(db, user_id, adventure_id)
        content = (adv.payload or {}).get("content") or {}
        if adv.kind == "side" or adv.status != "active" or not content:
            raise AdventureError(409, "Эту встречу уже нельзя сдать")
        questions = content["questions"]
        if not any(str(answers.get(q["id"], "")).strip() for q in questions):
            raise AdventureError(400, "Сначала ответь хотя бы на один вопрос")
        topic = db.get(GraphNode, adv.topic_id) if adv.topic_id else None
        blocks = [
            f"### {q['id']} ({q['kind']}): {q['question']}\nЭталон: {q['reference'] or '—'}\nОтвет ученика: {str(answers.get(q['id'], '')).strip()[:3000] or '(нет ответа)'}"
            for q in questions
        ]
        prompt = ctx.join_blocks(ctx.node_block(db, topic) if topic else "", "## Вопросы встречи и ответы\n\n" + "\n\n".join(blocks))
    graded = await get_llm().complete_json(system=ADVENTURE_GRADE_SYSTEM, prompt=prompt, schema=ADVENTURE_GRADE_SCHEMA, tier="fast")
    by_id = {str(r.get("id")): r for r in graded.get("results", [])}
    items = []
    for q in questions:
        r = by_id.get(q["id"], {})
        answer = str(answers.get(q["id"], "")).strip()
        items.append({
            "id": q["id"], "question": q["question"], "answer": answer,
            "score": max(0.0, min(100.0, float(r.get("score", 0)))) if answer else 0.0, "feedback": str(r.get("feedback", "")),
        })  # fmt: skip
    score = round(sum(i["score"] for i in items) / max(len(items), 1), 1)
    with SessionLocal() as db:
        adv = _owned(db, user_id, adventure_id)
        adv.result = {
            "score": score, "remembered": score >= RECALL_PASS_SCORE, "items": items, "summary": str(graded.get("summary", "")),
            "weak_concepts": [str(c) for c in graded.get("weak_concepts", [])][:6],
        }  # fmt: skip
        adv.status, adv.resolved_at = "done", utcnow()
        if adv.topic_id:
            _feed_cards(db, user_id, adv.topic_id, score)
        title, course_id = adv.title, adv.course_id
        db.commit()
        result = encounter_json(db, adv)
    spawn(memory.remember(user_id, f"course_{course_id}", f"Случайная встреча: {title} — результат {score}%. {graded.get('summary', '')}", source=f"adventure_{adventure_id}"))
    return result


def _feed_cards(db: Session, user_id: int, node_id: int, score: float) -> None:
    """A real recall attempt is worth a review: it moves the topic's two earliest-due cards like a self-grade would."""
    grade = "easy" if score >= 90 else "good" if score >= 65 else "hard" if score >= 45 else "again"
    for card in db.scalars(select(ReviewCard).where(ReviewCard.user_id == user_id, ReviewCard.node_id == node_id).order_by(ReviewCard.due_at).limit(2)).all():
        reviews.grade_card(card, grade)


# ---------- answers to an offer ----------


def dismiss(db: Session, user_id: int, adventure_id: int) -> Adventure:
    adv = _owned(db, user_id, adventure_id)
    if not (adv.status == "offered" or (adv.status == "active" and adv.kind != "side")):
        raise AdventureError(409, "Это уже не предложение")
    adv.status, adv.resolved_at = "dismissed", utcnow()
    return adv
