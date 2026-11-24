"""Stage logic for a knowledge-graph node: prologue -> lecture -> practice -> exam."""

import asyncio
import json
import logging
import math
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import memory
from ..db import SessionLocal
from ..llm import LLMProvider, get_llm
from ..models import (
    STAGES,
    Course,
    ExamAttempt,
    GraphEdge,
    GraphNode,
    IntegrityFlag,
    Message,
    Note,
    NodeProgress,
    PinnedExcerpt,
    Task,
    User,
    WorkspaceFile,
    utcnow,
)
from ..prompts import (
    ASSESS_SCHEMA,
    ASSESS_SYSTEM,
    CHECK_SCHEMA,
    CHECK_SYSTEM,
    EXAM_GRADE_REPAIR_SYSTEM,
    EXAM_GRADE_SCHEMA,
    EXAM_GRADE_SYSTEM,
    EXAM_TASKS_SYSTEM,
    LECTURE_APPROACH_ADVANCED,
    LECTURE_APPROACH_MIDDLE,
    LECTURE_APPROACH_NOVICE,
    LECTURE_MANDATORY,
    LECTURE_NO_VISUALS,
    LECTURE_RULES,
    LECTURE_START,
    LECTURE_SUMMARY_SCHEMA,
    LECTURE_SUMMARY_SYSTEM,
    LECTURE_VISUALS,
    MANDATORY_TASKS_RULES,
    NODE_MODE_HINT,
    PERSONA,
    PRACTICE_CHAT_RULES,
    PRACTICE_FOCUS,
    PRACTICE_INTERLEAVE,
    PRACTICE_TASKS_SYSTEM,
    PROLOGUE_MANDATORY,
    PROLOGUE_RULES,
    PROLOGUE_START,
    PROLOGUE_WARMUP,
    SIDE_CHALLENGE_RULES,
    TASKS_SCHEMA,
    TOOL_CATALOG,
    VERIFY_GRADE_SCHEMA,
    VERIFY_GRADE_SYSTEM,
    VERIFY_QUESTIONS_SCHEMA,
    VERIFY_QUESTIONS_SYSTEM,
)
from . import adventures
from . import context as ctx
from . import custom_tools, integrity, pins, reviews, visuals, workspace_layout
from . import path as route

log = logging.getLogger("meraki.learning")

PASS_SCORE = 60.0
PRACTICE_TASKS = 3
EXAM_TASKS = 3
EXAM_MINUTES_PER_TASK = 10


# ---------- progress & unlocking ----------


def get_progress(db: Session, user_id: int, node_id: int) -> NodeProgress:
    progress = db.scalar(select(NodeProgress).where(NodeProgress.user_id == user_id, NodeProgress.node_id == node_id))
    if progress is None:
        node = db.get(GraphNode, node_id)
        # a side quest has no prologue: the learner chose it themself, so it opens with the lecture
        progress = NodeProgress(user_id=user_id, node_id=node_id, stage="lecture" if node is not None and node.kind == "side" else "prologue")
        db.add(progress)
        db.flush()
    return progress


def completed_node_ids(db: Session, user_id: int, course_id: int) -> set[int]:
    return set(
        db.scalars(
            select(NodeProgress.node_id)
            .join(GraphNode, GraphNode.id == NodeProgress.node_id)
            .where(GraphNode.course_id == course_id, NodeProgress.user_id == user_id, NodeProgress.completed.is_(True))
        ).all()
    )


def is_unlocked(db: Session, user_id: int, node: GraphNode) -> bool:
    if node.owner_user_id is not None:
        return node.owner_user_id == user_id
    prereq = set(db.scalars(select(GraphEdge.src_id).where(GraphEdge.dst_id == node.id)).all())
    return prereq <= completed_node_ids(db, user_id, node.course_id)


async def refresh_memory(user_id: int, node_id: int) -> None:
    """MemPalace is queried rarely: once at the start of a stage, then reused from NodeProgress."""
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        if node is None:
            return
        query = f"{node.title}. {', '.join(node.concepts)}"
    recalled = await memory.recall(user_id, query, limit=4)
    with SessionLocal() as db:
        progress = get_progress(db, user_id, node_id)
        progress.memory_context = "\n".join(f"- {r}" for r in recalled)
        db.commit()


STAGE_TITLES = {"prologue": "пролог", "lecture": "лекция", "practice": "практика (чат с помощником)"}


async def file_dialogues(user_id: int, node_id: int, stages: tuple[str, ...] = ("prologue", "lecture", "practice")) -> int:
    """Files the not-yet-saved part of each stage's dialogue into MemPalace verbatim.

    MemPalace stores exact words rather than summaries, so later the tutor can recall what the
    learner actually said (their analogies, wrong guesses, questions) — not only our summary of it.
    """
    filed = 0
    for stage in stages:
        with SessionLocal() as db:
            node = db.get(GraphNode, node_id)
            if node is None:
                return filed
            course = db.get(Course, node.course_id)
            pending = db.scalars(
                select(Message)
                .where(Message.user_id == user_id, Message.node_id == node_id, Message.stage == stage, Message.memory_filed.is_(False))
                .order_by(Message.id)
            ).all()
            if not any(m.role == "user" for m in pending):
                continue  # nothing the learner said yet
            header = (
                f"[Диалог · {STAGE_TITLES.get(stage, stage)} · тема «{node.title}» · курс «{course.title if course else ''}» · "
                f"{pending[0].created_at:%Y-%m-%d}]"
            )
            lines = [f"{'Ученик' if m.role == 'user' else 'Наставник'}: {m.content}" for m in pending]
            transcript = header + "\n" + "\n\n".join(lines)
            for m in pending:
                m.memory_filed = True
            db.commit()
            course_id = node.course_id
        await memory.remember(user_id, f"course_{course_id}_dialogs", transcript, source=f"node_{node_id}_{stage}")
        filed += 1
    return filed


# ---------- dialogue stages ----------


def lecture_approach(progress: NodeProgress) -> str:
    level = float((progress.assessment or {}).get("overall_level", 0.3))
    if level < 0.35:
        return LECTURE_APPROACH_NOVICE
    if level > 0.7:
        return LECTURE_APPROACH_ADVANCED
    return LECTURE_APPROACH_MIDDLE


def chat_prompts(db: Session, user: User, node: GraphNode, stage: str, user_text: str | None) -> tuple[str, str]:
    course = db.get(Course, node.course_id)
    assert course is not None
    progress = get_progress(db, user.id, node.id)
    concepts = ", ".join(node.concepts)
    if stage == "prologue":
        card = reviews.warmup_card(db, user.id, node)
        warmup = PROLOGUE_WARMUP.format(question=card.question, answer=card.answer) if card else ""
        pinned_topics = pins.theory_outline(db, node)
        if pinned_topics:
            warmup += PROLOGUE_MANDATORY.format(topics=pinned_topics)
        rules = PROLOGUE_RULES.format(title=node.title, concepts=concepts, warmup=warmup)
        mats = ""
    elif stage == "lecture":
        rules = LECTURE_RULES.format(title=node.title, approach=lecture_approach(progress))
        pinned_theory = pins.theory_block(db, node)
        if pinned_theory:
            rules += "\n\n" + LECTURE_MANDATORY
        shown = visuals.lecture_block(db, node)  # only what the author approved
        rules += "\n\n" + (LECTURE_VISUALS if shown else LECTURE_NO_VISUALS)
        mats = ctx.join_blocks(
            pinned_theory, shown, ctx.materials_block(db, course.id, f"{node.title} {concepts} {user_text or ''}", limit=5)
        )
    else:
        rules = PRACTICE_CHAT_RULES.format(title=node.title)
        tasks = db.scalars(
            select(Task).where(Task.user_id == user.id, Task.node_id == node.id, Task.stage == "practice")
        ).all()
        mats = (
            "## Задания ученика (эталоны — только для тебя)\n"
            + "\n\n".join(f"### {t.title}\n{t.statement}\n\nЭталон: {t.solution or '—'}" for t in tasks)
            if tasks
            else ""
        )
    mode = route.node_mode(db, user.id, node)
    system = ctx.join_blocks(
        PERSONA,
        rules,
        NODE_MODE_HINT.get(mode, ""),
        ctx.learner_block(db, user),
        ctx.course_block(course, db),
        ctx.course_history_block(db, user.id, course.id),
        ctx.node_block(db, node),
        ctx.assessment_block(progress) if stage != "prologue" else "",
        ctx.memory_block(progress),
        mats,
    )
    stage_msgs = ctx.stage_messages(db, user.id, node.id, stage)
    recent_typing = [m.meta.get("typing") or {} for m in stage_msgs if m.role == "user"][-3:]
    state = integrity.typing_state(user, recent_typing)
    if state:
        system += f"\n\n## Состояние по динамике ввода\n{state}"
    history = ctx.history_text(stage_msgs)
    if user_text is None:
        start = PROLOGUE_START if stage == "prologue" else LECTURE_START if stage == "lecture" else "Поприветствуй и спроси, с чем помочь."
        prompt = (f"<история_диалога>\n{history}\n</история_диалога>\n\n" if history else "") + f"[Инструкция системы] {start}"
    else:
        prompt = (
            (f"<история_диалога>\n{history}\n</история_диалога>\n\n" if history else "")
            + "Ответь на последнее сообщение ученика (только текст ответа, без префикса «Наставник:»)."
        )
    return system, prompt


async def finish_prologue(user_id: int, node_id: int) -> dict[str, Any]:
    with SessionLocal() as db:
        user, node = db.get(User, user_id), db.get(GraphNode, node_id)
        assert user and node
        history = ctx.history_text(ctx.stage_messages(db, user_id, node_id, "prologue"), max_chars=20000)
        prompt = ctx.join_blocks(ctx.node_block(db, node), ctx.learner_block(db, user), f"## Диалог пролога\n{history or '(ученик сразу перешёл к лекции)'}")
    assessment = await get_llm().complete_json(system=ASSESS_SYSTEM, prompt=prompt, schema=ASSESS_SCHEMA, tier="fast")
    with SessionLocal() as db:
        progress = get_progress(db, user_id, node_id)
        progress.assessment = assessment
        progress.stage = "lecture"
        db.commit()
    await file_dialogues(user_id, node_id, ("prologue",))
    return assessment


async def finish_lecture(user_id: int, node_id: int, exit_ticket: str = "") -> None:
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        assert node
        history = ctx.history_text(ctx.stage_messages(db, user_id, node_id, "lecture"), max_chars=24000)
        course_id = node.course_id
        prompt = ctx.join_blocks(
            ctx.node_block(db, node),
            f"## Лекция\n{history or '(лекция пропущена)'}",
            f"## Пересказ ученика своими словами (выходной билет)\n{exit_ticket or '(нет)'}",
        )
    summary = await get_llm().complete_json(system=LECTURE_SUMMARY_SYSTEM, prompt=prompt, schema=LECTURE_SUMMARY_SCHEMA, tier="fast")
    with SessionLocal() as db:
        progress = get_progress(db, user_id, node_id)
        progress.lecture_summary = summary.get("summary", "")
        progress.exit_ticket = exit_ticket[:4000]
        progress.exit_ticket_feedback = summary.get("exit_ticket_feedback", "")
        progress.stage = "practice"
        if summary.get("summary"):
            content = summary["summary"]
            if progress.exit_ticket_feedback:
                content += f"\n\n---\n**Мой пересказ:** {exit_ticket}\n\n**Комментарий наставника:** {progress.exit_ticket_feedback}"
            db.add(Note(user_id=user_id, course_id=course_id, node_id=node_id, source="assistant",
                        title=summary.get("note_title") or f"Конспект: {node.title}", content=content))  # fmt: skip
        reviews.add_cards(db, user_id, course_id, node_id, summary.get("flashcards", []))
        db.commit()
    await file_dialogues(user_id, node_id, ("lecture",))


# ---------- practice ----------


def _write_starter_files(db: Session, user_id: int, course_id: int, files: list[dict[str, str]], folder: str) -> list[dict[str, str]]:
    """Writes a task's starter files under `folder` and returns them with their final paths.

    Never overwrites the learner's existing work: a clashing name gets a numeric suffix,
    so every task always sees its own fresh starter code.
    """
    taken = set(
        db.scalars(select(WorkspaceFile.path).where(WorkspaceFile.user_id == user_id, WorkspaceFile.course_id == course_id)).all()
    )
    written = []
    for f in files:
        name = str(f.get("path", "")).strip().replace("\\", "/").split("/")[-1]
        if not name or name in (".", ".."):
            continue
        stem, dot, ext = name.rpartition(".")
        stem, ext = (stem, f".{ext}") if dot else (name, "")
        path = f"{folder}/{name}"
        n = 2
        while path in taken:
            path = f"{folder}/{stem}_{n}{ext}"
            n += 1
        taken.add(path)
        content = str(f.get("content", ""))
        db.add(WorkspaceFile(user_id=user_id, course_id=course_id, path=path, content=content))
        written.append({"path": path, "content": content})
    if not written:
        # keep an empty task folder visible in the workspace tree
        keep = f"{folder}/.keep"
        if keep not in taken:
            db.add(WorkspaceFile(user_id=user_id, course_id=course_id, path=keep, content=""))
    return written


def _tasks_context(db: Session, user: User, node: GraphNode, course: Course) -> str:
    progress = get_progress(db, user.id, node.id)
    pinned_topics = pins.theory_outline(db, node, with_text=True)
    return ctx.join_blocks(
        ctx.course_block(course, db),
        ctx.node_block(db, node),
        ctx.learner_block(db, user),
        ctx.assessment_block(progress),
        f"## Обязательные темы преподавателя (их разбирали на лекции, задания должны это проверять)\n{pinned_topics}" if pinned_topics else "",
        f"## Конспект лекции\n{progress.lecture_summary}" if progress.lecture_summary else "",
        ctx.materials_block(db, course.id, f"задача упражнение {node.title} {' '.join(node.concepts)}", limit=4, kind="tasks"),
        ctx.materials_block(db, course.id, f"{node.title} {' '.join(node.concepts)}", limit=3),
    )


async def generate_practice_tasks(user_id: int, node_id: int, n: int = PRACTICE_TASKS, focus: list[str] | None = None) -> None:
    with SessionLocal() as db:
        user, node = db.get(User, user_id), db.get(GraphNode, node_id)
        assert user and node
        course = db.get(Course, node.course_id)
        assert course
        existing = db.scalars(select(Task.title).where(Task.user_id == user_id, Task.node_id == node_id, Task.stage == "practice")).all()
        side = node.kind == "side"
        if side:
            n = min(n, adventures.SIDE_TASKS)  # one closing challenge instead of a full practice
        done = completed_node_ids(db, user_id, course.id) - {node_id}
        prev = db.scalars(select(GraphNode).where(GraphNode.id.in_(done))).all() if done else []
        interleave = PRACTICE_INTERLEAVE.format(prev="; ".join(f"«{p.title}»: {', '.join(p.concepts[:3])}" for p in prev[-3:])) if prev and not side else ""
        mandatory = [] if side else pins.mandatory_tasks(db, user_id, node_id, "practice")
        total = max(n, len(mandatory) + 1) if mandatory else n  # the author's tasks come on top of at least one made for this learner
        system = PRACTICE_TASKS_SYSTEM.format(
            n=total, title=node.title, tools=", ".join([*(TOOL_CATALOG.get(t, t) for t in course.tools), *(f"«{t.name}»" for t in custom_tools.course_tools(db, course.id, True))]),
            interleave=interleave,
            focus=SIDE_CHALLENGE_RULES if side else PRACTICE_FOCUS.format(focus=", ".join(focus)) if focus else "",
            mandatory=_mandatory_rules(len(mandatory), total, hints=True),
        )  # fmt: skip
        prompt = ctx.join_blocks(_tasks_context(db, user, node, course), pins.mandatory_tasks_block(mandatory))
        if existing:
            prompt += "\n\nУже выданные задания (не повторяй): " + "; ".join(existing)
    result = await get_llm().complete_json(system=system, prompt=prompt, schema=TASKS_SCHEMA, tier="smart")
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        assert node
        course = db.get(Course, node.course_id)
        assert course
        topic = workspace_layout.topic_number(node)
        existing = len(
            db.scalars(
                select(Task.id).where(Task.user_id == user_id, Task.node_id == node_id, Task.stage == "practice")
            ).all()
        )
        for index, t in enumerate(_final_tasks(result.get("tasks", []), mandatory, total, cap=n if side else n + 2), start=1):
            task = _task_from_json(t, user_id, node_id, "practice")
            db.add(task)
            db.flush()  # the folder name includes the task number
            number = f"{topic}.{existing + index}"
            folder = workspace_layout.task_folder(course, node, "practice", number, task.title)
            task.workspace_folder = folder
            task.starter_files = _write_starter_files(db, user_id, course.id, t.get("starter_files", []), folder)
        db.commit()


def _mandatory_rules(m: int, total: int, hints: bool) -> str:
    if not m:
        return ""
    return MANDATORY_TASKS_RULES.format(m=m, n=total, rest=total - m, hints_part=", hints" if hints else "")


def _final_tasks(raw: list[dict[str, Any]], mandatory: list[PinnedExcerpt], total: int, cap: int) -> list[dict[str, Any]]:
    """The model's tasks, with the author's pinned ones guaranteed in; `excerpt_id` is trusted only for those."""
    if mandatory:
        return pins.merge_mandatory(raw, mandatory, total)
    for t in raw:
        t["excerpt_id"] = None
    return raw[:cap]


def _task_from_json(t: dict[str, Any], user_id: int, node_id: int, stage: str, attempt_id: int | None = None) -> Task:
    return Task(
        user_id=user_id, node_id=node_id, stage=stage, attempt_id=attempt_id,
        title=str(t.get("title", "Задание"))[:200], statement=str(t.get("statement", "")),
        kind=t.get("kind") if t.get("kind") in ("code", "text", "calc", "canvas") else "text",
        language=str(t.get("language", ""))[:30], concept=str(t.get("concept", ""))[:200], bloom=str(t.get("bloom", ""))[:20], scaffold=str(t.get("scaffold", ""))[:20],
        excerpt_id=t.get("excerpt_id"), starter_files=t.get("starter_files", []), rubric=str(t.get("rubric", "")), solution=str(t.get("solution", "")),
        hints=[] if stage == "exam" else [str(h) for h in t.get("hints", [])][:3],
    )  # fmt: skip


def render_submission(answer: str, files: list[dict[str, str]], canvas: str) -> str:
    parts = [f"Ответ ученика:\n{answer or '(пусто)'}"]
    for f in files[:8]:
        parts.append(f"Файл {f.get('path')}:\n```\n{str(f.get('content', ''))[:6000]}\n```")
    if canvas:
        # the description also carries the tool widgets that sit on the canvas, so it needs a bit more room
        parts.append(f"Холст (описание элементов и инструментов):\n{canvas[:4000]}")
    return "\n\n".join(parts)


async def check_practice(user_id: int, task_id: int, answer: str, files: list[dict[str, str]], canvas: str, confidence: int | None = None) -> Task:
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task and task.user_id == user_id
        node = db.get(GraphNode, task.node_id)
        assert node
        prompt = ctx.join_blocks(
            ctx.node_block(db, node),
            f"## Задание «{task.title}» ({task.kind} {task.language})\n{task.statement}\n\nКритерии (rubric): {task.rubric}"
            f"\n\nЭталонное решение (не раскрывай целиком): {task.solution or '—'}",
            "## Решение\n" + render_submission(answer, files, canvas),
            f"## Уверенность ученика перед сдачей: {confidence}/5" if confidence else "",
            f"## Предыдущая проверка этого задания\n{task.feedback}" if task.feedback else "",
        )
    result = await get_llm().complete_json(system=CHECK_SYSTEM, prompt=prompt, schema=CHECK_SCHEMA, tier="fast")
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task
        task.submitted_answer = answer
        task.answer = render_submission(answer, files, canvas)
        task.score = max(0.0, min(100.0, float(result.get("score", 0))))
        task.feedback = str(result.get("feedback", ""))
        task.status = "graded"
        task.confidence = confidence
        graded = db.scalars(
            select(Task.score).where(Task.user_id == user_id, Task.node_id == task.node_id, Task.stage == "practice", Task.status == "graded")
        ).all()
        progress = get_progress(db, user_id, task.node_id)
        progress.practice_score = round(sum(s or 0 for s in graded) / max(len(graded), 1), 1)
        node = db.get(GraphNode, task.node_id)
        if node is not None and node.kind == "side" and task.score >= adventures.SIDE_PASS_SCORE:
            adventures.complete_side(db, user_id, node, progress)  # no exam, no profile update, no replan: it is an extra
        db.commit()
        return task


# ---------- exam ----------


async def start_exam(user_id: int, node_id: int) -> int:
    with SessionLocal() as db:
        user, node = db.get(User, user_id), db.get(GraphNode, node_id)
        assert user and node
        course = db.get(Course, node.course_id)
        assert course
        open_attempt = db.scalar(
            select(ExamAttempt).where(ExamAttempt.user_id == user_id, ExamAttempt.node_id == node_id, ExamAttempt.status != "finished")
        )
        if open_attempt:
            return open_attempt.id
        flagged = integrity.practice_flagged_concepts(db, user_id, node_id)
        practice = db.scalars(select(Task).where(Task.user_id == user_id, Task.node_id == node_id, Task.stage == "practice")).all()
        practice_text = "\n".join(
            f"- «{t.title}» (понятие: {t.concept}) — {'оценка ' + str(round(t.score)) if t.score is not None else 'не сдано'}" for t in practice
        )
        mandatory = pins.mandatory_tasks(db, user_id, node_id, "exam")
        count = max(EXAM_TASKS, len(mandatory) + 1) if mandatory else EXAM_TASKS
        minutes = count * EXAM_MINUTES_PER_TASK
        system = EXAM_TASKS_SYSTEM.format(
            n=count, title=node.title, minutes=minutes,
            flagged=", ".join(f"{c} (сигналов: {n})" for c, n in flagged.items()) or "нет",
            mandatory=_mandatory_rules(len(mandatory), count, hints=False),
        )  # fmt: skip
        prompt = ctx.join_blocks(
            _tasks_context(db, user, node, course) + f"\n\n## Итоги практики\n{practice_text or 'практика не выполнялась'}",
            pins.mandatory_tasks_block(mandatory),
        )
    await refresh_memory(user_id, node_id)
    result = await get_llm().complete_json(system=system, prompt=prompt, schema=TASKS_SCHEMA, tier="smart")
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        assert node
        course = db.get(Course, node.course_id)
        assert course
        attempt = ExamAttempt(user_id=user_id, node_id=node_id, time_limit_min=minutes)
        db.add(attempt)
        db.flush()
        topic = workspace_layout.topic_number(node)
        existing = len(
            db.scalars(
                select(Task.id).where(Task.user_id == user_id, Task.node_id == node_id, Task.stage == "exam")
            ).all()
        )
        for index, t in enumerate(_final_tasks(result.get("tasks", []), mandatory, count, cap=EXAM_TASKS + 1), start=1):
            task = _task_from_json(t, user_id, node_id, "exam", attempt.id)
            db.add(task)
            db.flush()  # the folder name includes the task number
            number = f"{topic}.{existing + index}"
            folder = workspace_layout.task_folder(course, node, "exam", number, task.title)
            task.workspace_folder = folder
            task.starter_files = _write_starter_files(db, user_id, course.id, t.get("starter_files", []), folder)
        get_progress(db, user_id, node_id).stage = "exam"
        db.commit()
        attempt_id = attempt.id
    await file_dialogues(user_id, node_id, ("practice",))  # the practice helper chat ends here
    return attempt_id


# ---------- exam grading: points -> percentage ----------


class GradingContractError(ValueError):
    """The grader broke the points/max_points contract, so its score cannot be trusted."""


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise GradingContractError(f"{field}: ожидалось число, получено {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError) as e:
        raise GradingContractError(f"{field}: ожидалось число, получено {value!r}") from e
    if not math.isfinite(number):
        raise GradingContractError(f"{field}: ожидалось конечное число, получено {value!r}")
    return number


def normalize_exam_score(result: dict[str, Any]) -> float:
    """Convert raw rubric points to a 0..100 percentage.

    Rubrics may use arbitrary maxima (7, 10, 27, ...). Asking the model to normalize them to
    percentages proved unreliable, so the model returns points/max_points and we do the arithmetic.
    """
    points = _finite_number(result.get("points"), "points")
    max_points = _finite_number(result.get("max_points"), "max_points")
    if max_points <= 0:
        raise GradingContractError("max_points должен быть больше нуля")
    if points < 0 or points > max_points:
        raise GradingContractError(f"points={points} вне диапазона 0..{max_points}")
    return round(max(0.0, min(100.0, 100.0 * points / max_points)), 1)


def validate_exam_grade(grade: dict[str, Any], task_ids: set[int]) -> dict[int, float]:
    """Check every task got exactly one valid points/max_points result."""
    results = grade.get("results")
    if not isinstance(results, list):
        raise GradingContractError("в ответе нет списка results")
    scores: dict[int, float] = {}
    for item in results:
        if not isinstance(item, dict):
            raise GradingContractError("элемент results — не объект")
        if isinstance(item.get("task_id"), bool):
            raise GradingContractError(f"некорректный task_id: {item.get('task_id')!r}")
        try:
            task_id = int(item.get("task_id"))
        except (TypeError, ValueError) as e:
            raise GradingContractError(f"некорректный task_id: {item.get('task_id')!r}") from e
        if task_id not in task_ids:
            continue  # a hallucinated id must not affect real tasks
        if task_id in scores:
            raise GradingContractError(f"task_id={task_id} встречается несколько раз")
        scores[task_id] = normalize_exam_score(item)
    missing = sorted(task_ids - scores.keys())
    if missing:
        raise GradingContractError(f"нет оценки для task_id={missing}")
    return scores


async def _grade_exam(llm: LLMProvider, prompt: str, task_ids: set[int]) -> tuple[dict[int, float], dict[str, Any]]:
    """Grade an exam, retrying once if the model breaks the points/max_points contract."""
    grade = await llm.complete_json(system=EXAM_GRADE_SYSTEM, prompt=prompt, schema=EXAM_GRADE_SCHEMA, tier="smart")
    try:
        return validate_exam_grade(grade, task_ids), grade
    except GradingContractError as first_error:
        log.warning("exam grading contract violation (%s); asking the model to repair it", first_error)
        repair_prompt = (
            f"{prompt}\n\n## Предыдущий ответ экзаменатора (нарушает контракт)\n"
            f"{json.dumps(grade, ensure_ascii=False)[:8000]}\n\n"
            f"## Нарушение\n{first_error}\n\n"
            "Верни исправленный JSON: для каждого задания обязательны points и max_points; "
            "points — набранные сырые баллы, max_points — максимум баллов по rubric; 0 <= points <= max_points."
        )
        repaired = await llm.complete_json(
            system=EXAM_GRADE_REPAIR_SYSTEM, prompt=repair_prompt, schema=EXAM_GRADE_SCHEMA, tier="smart"
        )
        return validate_exam_grade(repaired, task_ids), repaired


async def submit_exam(user_id: int, attempt_id: int, answers: dict[str, dict[str, Any]]) -> None:
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt and attempt.user_id == user_id and attempt.status == "in_progress"
        tasks = db.scalars(select(Task).where(Task.attempt_id == attempt_id).order_by(Task.id)).all()
        for t in tasks:
            a = answers.get(str(t.id)) or {}
            raw = str(a.get("answer", ""))
            # A client that lost its draft after a failed grading run may retry with empty
            # fields. Do not erase an answer that is already saved on the server.
            if not raw.strip() and t.submitted_answer.strip():
                raw = t.submitted_answer
            t.submitted_answer = raw
            t.answer = render_submission(raw, a.get("files") or [], str(a.get("canvas", "")))
        db.commit()  # answers are saved even if grading fails, so a retry can resubmit them
    await _grade_saved_attempt(attempt_id, regenerate_verification=True)


async def regrade_exam(attempt_id: int, *, keep_defence: bool | None = None) -> None:
    """Re-run grading from the answers already saved on the attempt.

    Used to repair an attempt whose first grading run failed: the answers stay in Task.answer,
    so the learner does not have to retake the exam. When the learner has already passed the
    defence (understanding is stored), those answers and their multiplier are reused instead
    of asking the verification questions again.
    """
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt
        if keep_defence is None:
            keep_defence = attempt.understanding is not None
        if not keep_defence:
            attempt.verification = []
            attempt.understanding = None
        attempt.status = "in_progress"
        attempt.finished_at = None
        attempt.raw_score = None
        attempt.score = None
        attempt.weak_concepts = []
        # Keep attempt.summary: _grade_saved_attempt carries its defence paragraph over.
        db.commit()
    await _grade_saved_attempt(attempt_id, regenerate_verification=not keep_defence)


async def _grade_saved_attempt(attempt_id: int, *, regenerate_verification: bool) -> None:
    """Grade the answers already stored on the attempt's tasks and update its state."""
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt
        node = db.get(GraphNode, attempt.node_id)
        assert node
        tasks = db.scalars(select(Task).where(Task.attempt_id == attempt_id).order_by(Task.id)).all()
        blocks = [
            f"### task_id={t.id}: «{t.title}» ({t.kind} {t.language})\n{t.statement}\nКритерии: {t.rubric}\n"
            f"Эталон: {t.solution or '—'}\n\n{t.answer}"
            for t in tasks
        ]
        prompt = ctx.join_blocks(ctx.node_block(db, node), "## Экзаменационные задания и ответы\n\n" + "\n\n".join(blocks))
        fragments = [f for f in integrity.flags_for_attempt(db, attempt_id) if f.fragment.strip()]
        fragments_text = "\n\n".join(f"flag_id={f.id} ({f.kind}, {f.target}):\n```\n{f.fragment[:1500]}\n```" for f in fragments[:6])
        node_block = ctx.node_block(db, node)
        task_ids = {t.id for t in tasks}
        previous_summary = attempt.summary or ""

    defence_note = ""
    marker = "**Проверка понимания:**"
    if not regenerate_verification and marker in previous_summary:
        defence_note = previous_summary.split(marker, 1)[1].strip()

    llm = get_llm()
    grade_task = _grade_exam(llm, prompt, task_ids)
    if fragments and regenerate_verification:
        q_prompt = ctx.join_blocks(node_block, "## Помеченные фрагменты\n" + fragments_text, "## Контекст решений\n" + prompt[-12000:])
        (scores_by_task, grade), questions = await asyncio.gather(
            grade_task, llm.complete_json(system=VERIFY_QUESTIONS_SYSTEM, prompt=q_prompt, schema=VERIFY_QUESTIONS_SCHEMA, tier="fast")
        )
    else:
        (scores_by_task, grade), questions = await grade_task, {"questions": []}

    feedback_by_task = {
        int(r.get("task_id", 0)): str(r.get("feedback", ""))
        for r in grade.get("results", [])
        if isinstance(r, dict) and r.get("task_id") is not None
    }
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt
        tasks = {t.id: t for t in db.scalars(select(Task).where(Task.attempt_id == attempt_id)).all()}
        for task_id, score in scores_by_task.items():
            t = tasks.get(task_id)
            if t:
                t.score = score
                t.feedback = feedback_by_task.get(task_id, "")
                t.status = "graded"
        scores = [t.score or 0.0 for t in tasks.values()]
        attempt.finished_at = utcnow()
        attempt.raw_score = round(sum(scores) / max(len(scores), 1), 1)
        attempt.summary = str(grade.get("overall_comment", ""))
        attempt.weak_concepts = [str(c) for c in grade.get("weak_concepts", [])][:8]
        if regenerate_verification:
            valid_ids = {f.id for f in fragments}
            frag_by_id = {f.id: f for f in fragments}
            attempt.verification = [
                {"flag_id": int(q["flag_id"]), "question": q["question"], "fragment": frag_by_id[int(q["flag_id"])].fragment[:1500],
                 "kind": frag_by_id[int(q["flag_id"])].kind, "answer": None, "understood": None, "comment": ""}
                for q in questions.get("questions", []) if int(q.get("flag_id", 0)) in valid_ids
            ]  # fmt: skip
            if attempt.verification:
                attempt.status = "verifying"
                db.commit()
                return
            attempt.score = attempt.raw_score
            attempt.status = "finished"
        elif attempt.understanding is not None:
            # The defence was already completed; reuse its score instead of asking again.
            attempt.score = round((attempt.raw_score or 0) * (0.6 + 0.4 * attempt.understanding), 1)
            attempt.status = "finished"
        elif attempt.verification:
            attempt.status = "verifying"
        else:
            attempt.score = attempt.raw_score
            attempt.status = "finished"
        if defence_note:
            attempt.summary = (attempt.summary + "\n\n" + marker + " " + defence_note).strip()
        finished = attempt.status == "finished"
        user_id = attempt.user_id
        db.commit()
    if finished:
        await _finalize_exam(user_id, attempt_id)


async def verify_exam(user_id: int, attempt_id: int, answers: dict[str, str]) -> None:
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt and attempt.user_id == user_id and attempt.status == "verifying"
        items = [dict(v) for v in attempt.verification]
        for item in items:
            item["answer"] = str(answers.get(str(item["flag_id"]), ""))[:4000]
        attempt.verification = items
        db.commit()
        qa = "\n\n".join(
            f"flag_id={i['flag_id']}\nФрагмент:\n```\n{i['fragment']}\n```\nВопрос: {i['question']}\nОтвет ученика: {i['answer'] or '(нет ответа)'}"
            for i in items
        )
    result = await get_llm().complete_json(system=VERIFY_GRADE_SYSTEM, prompt=qa, schema=VERIFY_GRADE_SCHEMA, tier="fast")
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt
        by_flag = {int(r.get("flag_id", 0)): r for r in result.get("results", [])}
        items = []
        for item in attempt.verification:
            r = by_flag.get(int(item["flag_id"]), {})
            items.append({**item, "understood": bool(r.get("understood", False)), "comment": str(r.get("comment", ""))})
        attempt.verification = items
        understanding = max(0.0, min(1.0, float(result.get("understanding", 0))))
        attempt.understanding = understanding
        # Unexplained suspicious fragments cost up to 40% of the exam score
        attempt.score = round((attempt.raw_score or 0) * (0.6 + 0.4 * understanding), 1)
        attempt.summary = (attempt.summary + "\n\n**Проверка понимания:** " + str(result.get("summary", ""))).strip()
        attempt.status = "finished"
        db.commit()
    await _finalize_exam(user_id, attempt_id)


async def _finalize_exam(user_id: int, attempt_id: int) -> None:
    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, attempt_id)
        assert attempt
        node = db.get(GraphNode, attempt.node_id)
        assert node
        progress = get_progress(db, user_id, attempt.node_id)
        progress.exam_score = max(progress.exam_score or 0, attempt.score or 0)
        passed = (attempt.score or 0) >= PASS_SCORE
        first_pass = passed and not progress.completed  # retaking a passed exam must not roll for adventures again
        if passed:
            progress.completed = True
            progress.stage = "done"
        flags = db.scalars(select(IntegrityFlag).where(IntegrityFlag.user_id == user_id, IntegrityFlag.node_id == node.id)).all()
        course = db.get(Course, node.course_id)
        a = progress.assessment or {}
        record = (
            f"Тема «{node.title}» курса «{course.title if course else ''}»: экзамен {attempt.score}% "
            f"({'сдан' if passed else 'не сдан'}), практика {progress.practice_score}%. "
            f"Диагностика пролога: уровень {a.get('overall_level', '?')}, заблуждения: {'; '.join(a.get('misconceptions', [])) or 'нет'}. "
            f"Сигналы несамостоятельности: практика {sum(f.stage == 'practice' for f in flags)}, экзамен {sum(f.stage == 'exam' for f in flags)}"
            + (f", понимание при проверке {attempt.understanding:.2f}" if attempt.understanding is not None else "")
            + f". Итог экзаменатора: {attempt.summary[:600]}"
        )
        course_id = node.course_id
        db.commit()
    await memory.remember(user_id, f"course_{course_id}", record, source=f"node_{node.id}_exam_{attempt_id}")
    await file_dialogues(user_id, node.id)  # anything said after the stage moved on (lecture revisits etc.)
    if passed:
        await memory.add_fact(user_id, "mastered", node.title)
        from ..background import spawn
        from .profile import update_profile

        async def after_node() -> None:
            await update_profile(user_id)  # talents first, then the route uses them
            await route.replan(user_id, course_id)
            if first_pass:
                await adventures.roll_after_pass(user_id, node.id)  # last: a bridge encounter targets the replanned route

        spawn(after_node())


def stage_index(stage: str) -> int:
    return STAGES.index(stage) if stage in STAGES else len(STAGES)


def tasks_json(tasks: list[Task], reveal_hints: bool = True) -> list[dict[str, Any]]:
    return [
        {
            "id": t.id, "title": t.title, "statement": t.statement, "kind": t.kind, "language": t.language,
            "concept": t.concept, "bloom": t.bloom, "scaffold": t.scaffold, "confidence": t.confidence,
            "starter_files": [f.get("path") for f in t.starter_files], "folder": t.workspace_folder or "",
            "status": t.status, "from_author": t.excerpt_id is not None,
            "score": t.score, "feedback": t.feedback, "hints": t.hints if reveal_hints else [],
            "submitted_answer": t.submitted_answer or "",
        }  # fmt: skip
        for t in tasks
    ]


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
