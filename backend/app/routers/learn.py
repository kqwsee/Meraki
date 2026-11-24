import json
import logging
from collections.abc import Coroutine
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..background import spawn
from ..db import SessionLocal, get_db
from ..llm import LLMError, get_llm
from ..models import Course, Enrollment, ExamAttempt, GraphNode, Message, ReviewCard, Task, User
from ..security import current_user
from ..services import context as ctx
from ..services import assets, custom_tools, integrity, learning, talents, visuals
from ..services import path as route

log = logging.getLogger("meraki.learn")
router = APIRouter(prefix="/api", tags=["learn"])

# Long AI jobs per (user, node): "practice_tasks" | "exam_start" | "exam_grading" | "exam_verify"
_jobs: dict[tuple[int, int], dict[str, Any]] = {}


def _run_job(user_id: int, node_id: int, kind: str, coro: Coroutine[Any, Any, Any]) -> None:
    key = (user_id, node_id)
    if key in _jobs and not _jobs[key].get("error"):
        coro.close()
        raise HTTPException(409, "ИИ уже работает над этой темой, подождите")
    _jobs[key] = {"kind": kind, "error": None}

    async def wrapper() -> None:
        try:
            await coro
            _jobs.pop(key, None)
        except Exception as e:
            log.exception("job %s failed", kind)
            _jobs[key] = {"kind": kind, "error": str(e) or e.__class__.__name__}

    spawn(wrapper())


class ChatIn(BaseModel):
    content: str | None = None
    typing: dict[str, Any] | None = None


class AdvanceIn(BaseModel):
    to: str
    exit_ticket: str = ""


class SubmitIn(BaseModel):
    answer: str = ""
    files: list[dict[str, str]] = []
    canvas: str = ""
    confidence: int | None = None


class MoreIn(BaseModel):
    focus: list[str] = []


class ExamSubmitIn(BaseModel):
    answers: dict[str, dict[str, Any]]


class VerifyIn(BaseModel):
    answers: dict[str, str]


def _node_for(db: Session, node_id: int, user: User) -> GraphNode:
    node = db.get(GraphNode, node_id)
    if node is None or (node.owner_user_id is not None and node.owner_user_id != user.id):
        raise HTTPException(404, "Тема не найдена")
    if db.scalar(select(Enrollment).where(Enrollment.user_id == user.id, Enrollment.course_id == node.course_id)) is None:
        raise HTTPException(403, "Сначала запишитесь на курс")
    if not learning.is_unlocked(db, user.id, node):
        raise HTTPException(403, "Тема ещё закрыта: сначала пройдите предыдущие темы")
    return node


def _msg_json(m: Message) -> dict[str, Any]:
    return {"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at.isoformat()}


def _attempt_json(db: Session, a: ExamAttempt) -> dict[str, Any]:
    tasks = db.scalars(select(Task).where(Task.attempt_id == a.id).order_by(Task.id)).all()
    finished = a.status == "finished"
    return {
        "id": a.id, "status": a.status, "time_limit_min": a.time_limit_min,
        "started_at": a.started_at.isoformat() + "Z", "raw_score": a.raw_score if finished else None,
        "score": a.score, "understanding": a.understanding, "summary": a.summary if finished else "",
        "weak_concepts": a.weak_concepts if finished else [],
        "tasks": [
            {**t, "score": t["score"] if finished else None, "feedback": t["feedback"] if finished else ""}
            for t in learning.tasks_json(list(tasks), reveal_hints=False)
        ],
        "verification": [
            {k: v for k, v in item.items() if finished or k not in ("understood", "comment")} for item in a.verification
        ],
    }  # fmt: skip


@router.get("/nodes/{node_id}/state")
def node_state(node_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    node = _node_for(db, node_id, user)
    course = db.get(Course, node.course_id)
    assert course
    progress = learning.get_progress(db, user.id, node_id)
    db.commit()
    practice = db.scalars(
        select(Task).where(Task.user_id == user.id, Task.node_id == node_id, Task.stage == "practice").order_by(Task.id)
    ).all()
    attempts = db.scalars(
        select(ExamAttempt).where(ExamAttempt.user_id == user.id, ExamAttempt.node_id == node_id).order_by(ExamAttempt.id.desc())
    ).all()
    job = _jobs.get((user.id, node_id))
    if job and job.get("error"):
        _jobs.pop((user.id, node_id), None)
    return {
        "node": {"id": node.id, "title": node.title, "summary": node.summary, "objectives": node.objectives, "concepts": node.concepts,
                 "mode": route.node_mode(db, user.id, node), "personal": node.owner_user_id is not None, "kind": node.kind,
                 "cover": assets.cover_urls(db, [node]).get(node.id)},
        "visuals": visuals.with_assets(db, visuals.node_visuals(db, node.id, approved_only=True)),
        "course": {"id": course.id, "title": course.title, "domain": course.domain, "tools": course.tools,
                   "custom_tools": [custom_tools.tool_json(t) for t in custom_tools.course_tools(db, course.id, enabled_only=True)]},
        "progress": {
            "stage": progress.stage, "completed": progress.completed, "assessment": progress.assessment,
            "practice_score": progress.practice_score, "exam_score": progress.exam_score,
            "exit_ticket": progress.exit_ticket, "exit_ticket_feedback": progress.exit_ticket_feedback,
        },
        "messages": {s: [_msg_json(m) for m in ctx.stage_messages(db, user.id, node_id, s)] for s in ("prologue", "lecture", "practice")},
        "practice_tasks": learning.tasks_json(list(practice)),
        "exam": _attempt_json(db, attempts[0]) if attempts else None,
        "exam_history": [{"id": a.id, "score": a.score, "status": a.status} for a in attempts[1:]],
        "job": job,
        "pass_score": learning.PASS_SCORE,
    }  # fmt: skip


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/nodes/{node_id}/chat/{stage}")
async def chat(node_id: int, stage: str, body: ChatIn, user: User = Depends(current_user)):
    if stage not in ("prologue", "lecture", "practice"):
        raise HTTPException(400, "Чат недоступен на этом этапе")
    with SessionLocal() as db:
        node = _node_for(db, node_id, user)
        progress = learning.get_progress(db, user.id, node_id)
        if learning.stage_index(stage) > learning.stage_index(progress.stage):
            raise HTTPException(400, "Этот этап ещё не открыт")
        has_messages = bool(ctx.stage_messages(db, user.id, node_id, stage))
        db.commit()
        if body.content is None and has_messages:
            raise HTTPException(409, "Этап уже начат")
    if body.content is None and stage in ("prologue", "lecture"):
        await learning.refresh_memory(user.id, node_id)  # MemPalace: read once per stage start
    user_message_id: int | None = None
    with SessionLocal() as db:
        db_user = db.get(User, user.id)
        node = db.get(GraphNode, node_id)
        assert db_user and node
        if body.content is not None:
            text = body.content.strip()[:8000]
            if not text:
                raise HTTPException(400, "Пустое сообщение")
            message = Message(
                user_id=user.id, node_id=node_id, stage=stage, role="user", content=text, meta={"typing": body.typing or {}}
            )
            db.add(message)
            db.commit()
            user_message_id = message.id
        system, prompt = learning.chat_prompts(db, db_user, node, stage, body.content)
    if user_message_id is not None:
        # immediate, debounced: the talent page updates while the tutor's answer is still streaming
        talents.schedule_analysis(user.id, [user_message_id])

    async def gen():
        full = ""
        try:
            async for delta in get_llm().stream(system=system, prompt=prompt, tier="fast"):
                full += delta
                yield _sse({"type": "delta", "text": delta})
        except LLMError as e:
            yield _sse({"type": "error", "message": str(e)})
        if full.strip():
            with SessionLocal() as db:
                m = Message(user_id=user.id, node_id=node_id, stage=stage, role="assistant", content=full)
                db.add(m)
                db.commit()
                yield _sse({"type": "done", "message": _msg_json(m)})
        else:
            yield _sse({"type": "done", "message": None})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/nodes/{node_id}/advance")
async def advance(node_id: int, body: AdvanceIn, user: User = Depends(current_user)):
    with SessionLocal() as db:
        node = _node_for(db, node_id, user)
        progress = learning.get_progress(db, user.id, node_id)
        current = progress.stage
        mode = route.node_mode(db, user.id, node)
        db.commit()
    order = ["prologue", "lecture", "practice", "exam"]
    if node.kind == "side" and not (body.to == "practice" and current == "lecture"):
        raise HTTPException(400, "У побочного квеста два шага: лекция и вызов")
    # "Экстерн": in fast mode the learner may go straight to the exam from any stage
    external = body.to == "exam" and mode == "fast" and current in order[:3]
    if not external and (body.to not in order[1:] or current not in order or order.index(body.to) != order.index(current) + 1):
        raise HTTPException(400, f"Нельзя перейти с этапа «{current}» на «{body.to}»")
    try:
        if external and current == "prologue":
            await learning.finish_prologue(user.id, node_id)
        if body.to == "lecture":
            await learning.finish_prologue(user.id, node_id)
        elif body.to == "practice":
            await learning.finish_lecture(user.id, node_id, body.exit_ticket)
            _run_job(user.id, node_id, "practice_tasks", learning.generate_practice_tasks(user.id, node_id))
        else:
            _run_job(user.id, node_id, "exam_start", learning.start_exam(user.id, node_id))
    except LLMError as e:
        raise HTTPException(502, str(e))
    return {"ok": True}


@router.post("/nodes/{node_id}/practice/more")
async def more_tasks(node_id: int, body: MoreIn | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _node_for(db, node_id, user)
    focus = (body.focus if body else [])[:6] or None
    _run_job(user.id, node_id, "practice_tasks", learning.generate_practice_tasks(user.id, node_id, n=2, focus=focus))
    return {"ok": True}


@router.post("/nodes/{node_id}/exam/retry")
async def retry_exam(node_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if _node_for(db, node_id, user).kind == "side":
        raise HTTPException(400, "У побочного квеста нет экзамена")
    progress = learning.get_progress(db, user.id, node_id)
    if progress.stage not in ("exam", "done"):
        raise HTTPException(400, "Экзамен ещё не открыт")
    _run_job(user.id, node_id, "exam_start", learning.start_exam(user.id, node_id))
    return {"ok": True}


@router.post("/tasks/{task_id}/submit")
async def submit_task(task_id: int, body: SubmitIn, user: User = Depends(current_user)):
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        if task is None or task.user_id != user.id or task.stage != "practice":
            raise HTTPException(404, "Задание не найдено")
    try:
        confidence = max(1, min(5, body.confidence)) if body.confidence else None
        task = await learning.check_practice(user.id, task_id, body.answer, body.files, body.canvas, confidence)
    except LLMError as e:
        raise HTTPException(502, str(e))
    return learning.tasks_json([task])[0]


@router.post("/exams/{attempt_id}/submit")
async def submit_exam(attempt_id: int, body: ExamSubmitIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    attempt = db.get(ExamAttempt, attempt_id)
    if attempt is None or attempt.user_id != user.id:
        raise HTTPException(404, "Попытка не найдена")
    if attempt.status != "in_progress":
        raise HTTPException(409, "Экзамен уже сдан")
    _run_job(user.id, attempt.node_id, "exam_grading", learning.submit_exam(user.id, attempt_id, body.answers))
    return {"ok": True}


@router.post("/exams/{attempt_id}/verify")
async def verify_exam(attempt_id: int, body: VerifyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    attempt = db.get(ExamAttempt, attempt_id)
    if attempt is None or attempt.user_id != user.id:
        raise HTTPException(404, "Попытка не найдена")
    if attempt.status != "verifying":
        raise HTTPException(409, "Проверка понимания не требуется")
    _run_job(user.id, attempt.node_id, "exam_verify", learning.verify_exam(user.id, attempt_id, body.answers))
    return {"ok": True}


@router.get("/nodes/{node_id}/flags")
def node_flags(node_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Practice self-reliance signals, shown to the learner transparently (they are never punished in practice)."""
    _node_for(db, node_id, user)
    return integrity.practice_flagged_concepts(db, user.id, node_id)
