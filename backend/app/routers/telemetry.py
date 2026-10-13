import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..background import spawn
from ..db import get_db
from ..models import LearningSession, User, utcnow
from ..security import current_user
from ..services import integrity
from ..services.sessions import end_session, summarize_session

router = APIRouter(prefix="/api", tags=["telemetry"])


class BatchIn(BaseModel):
    session_id: str
    node_id: int | None = None
    stage: str = ""
    task_id: int | None = None
    attempt_id: int | None = None
    events: list[dict[str, Any]]


@router.post("/sessions")
def start_session(user: User = Depends(current_user), db: Session = Depends(get_db)):
    sess = LearningSession(id=uuid.uuid4().hex, user_id=user.id)
    db.add(sess)
    db.commit()
    return {"session_id": sess.id}


@router.post("/sessions/{session_id}/end")
async def stop_session(session_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    sess = db.get(LearningSession, session_id)
    if sess is None or sess.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")
    if end_session(session_id):
        spawn(summarize_session(session_id))  # session summary -> MemPalace
    return {"ok": True}


@router.post("/telemetry")
def telemetry(body: BatchIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    sess = db.get(LearningSession, body.session_id)
    if sess is None or sess.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")
    sess.last_activity = utcnow()
    flags = integrity.ingest(
        db, user, session_id=body.session_id, node_id=body.node_id, stage=body.stage,
        task_id=body.task_id, attempt_id=body.attempt_id, events=body.events,
    )  # fmt: skip
    db.commit()
    return {"stored": len(body.events), "flags": flags}
