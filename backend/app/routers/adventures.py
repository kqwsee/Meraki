from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Enrollment, User
from ..security import current_user
from ..services import adventures

router = APIRouter(prefix="/api", tags=["adventures"])


class SubmitIn(BaseModel):
    answers: dict[str, str]


def _fail(e: adventures.AdventureError) -> HTTPException:
    return HTTPException(e.status, str(e))


@router.get("/adventures/{adventure_id}")
def get_adventure(adventure_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    try:
        return adventures.encounter_json(db, adventures._owned(db, user.id, adventure_id))
    except adventures.AdventureError as e:
        raise _fail(e)


@router.post("/adventures/{adventure_id}/accept")
async def accept(adventure_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Side quest: becomes a personal topic to open. Encounter: the content is prepared (once) and the page can open."""
    try:
        adv = adventures._owned(db, user.id, adventure_id)
        if adv.status not in ("offered", "active"):
            raise adventures.AdventureError(409, "Это приключение уже закончилось")
        if adv.kind == "side":
            node = adventures.accept_side(db, user.id, adv)
            db.commit()
            return {"kind": "side", "node_id": node.id}
        kind = adv.kind
        db.close()  # the generation below can take a while; it opens its own sessions
        await adventures.start_encounter(user.id, adventure_id)
        return {"kind": kind, "adventure_id": adventure_id}
    except adventures.AdventureError as e:
        raise _fail(e)


@router.post("/adventures/{adventure_id}/dismiss")
def dismiss(adventure_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    try:
        adventures.dismiss(db, user.id, adventure_id)
    except adventures.AdventureError as e:
        raise _fail(e)
    db.commit()
    return {"ok": True}


@router.post("/adventures/{adventure_id}/submit")
async def submit(adventure_id: int, body: SubmitIn, user: User = Depends(current_user)):
    try:
        return await adventures.submit_encounter(user.id, adventure_id, body.answers)
    except adventures.AdventureError as e:
        raise _fail(e)


@router.post("/courses/{course_id}/adventures/roll")
async def roll(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Dev tool (ADVENTURE_DEV_TOOLS=true): rolls as if the learner had just passed their latest topic, ignoring the pacing."""
    if not settings.adventure_dev_tools:
        raise HTTPException(404, "Не найдено")
    if db.scalar(select(Enrollment).where(Enrollment.user_id == user.id, Enrollment.course_id == course_id)) is None:
        raise HTTPException(403, "Сначала запишитесь на курс")
    passed = adventures.passed_topics(db, user.id, course_id)
    if not passed:
        raise HTTPException(400, "Нужна хотя бы одна пройденная тема")
    last = passed[-1][0].id
    db.close()
    new_id = await adventures.roll_after_pass(user.id, last, force=True)
    if new_id is None:
        raise HTTPException(409, "Сейчас нечего предложить: нет свидетельств интереса и нет подходящих тем для встречи")
    return {"id": new_id}
