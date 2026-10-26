from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import memory
from ..background import spawn
from ..db import get_db
from ..models import Enrollment, Event, GraphNode, MemoryEntry, Note, ReviewCard, User
from ..security import current_user
from ..services import integrity, reviews
from ..services.context import MIND_AXES, course_progress
from ..services.profile import update_profile

router = APIRouter(prefix="/api", tags=["profile"])


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = ""
    course_id: int | None = None
    node_id: int | None = None


class NotePatch(BaseModel):
    title: str | None = None
    content: str | None = None


def note_json(n: Note) -> dict:
    return {
        "id": n.id, "title": n.title, "content": n.content, "source": n.source, "course_id": n.course_id,
        "node_id": n.node_id, "updated_at": n.updated_at.isoformat(),
    }  # fmt: skip


@router.get("/profile")
async def profile(user: User = Depends(current_user), db: Session = Depends(get_db)):
    enrollments = db.scalars(select(Enrollment).where(Enrollment.user_id == user.id)).all()
    memories = db.scalars(
        select(MemoryEntry).where(MemoryEntry.user_id == user.id).order_by(MemoryEntry.id.desc()).limit(20)
    ).all()
    return {
        "user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role},
        "courses": [
            {"id": e.course_id, "title": e.course.title, "domain": e.course.domain,
             "progress": course_progress(db, user.id, e.course_id)}
            for e in enrollments
        ],  # fmt: skip
        "talents": user.talents,
        "mind_profile": user.mind_profile,
        "mind_axes": MIND_AXES,
        "strengths": user.strengths,
        "growth_areas": user.growth_areas,
        "profile_updated_at": user.profile_updated_at.isoformat() if user.profile_updated_at else None,
        "integrity": integrity.user_stats(db, user),
        "reviews": _review_stats(db, user.id),
        "memory": {
            "status": memory.memory_status(),
            "entries": [{"room": m.room, "content": m.content, "created_at": m.created_at.isoformat()} for m in memories],
            "facts": _facts_with_courses(await memory.facts(user.id), user.fact_clusters),
        },
    }


def _facts_with_courses(facts: list[dict], clusters: dict[str, int]) -> list[dict]:
    """Attach the course_id the AI last assigned each memory fact to (see services.profile.update_profile),
    so the frontend's knowledge-map graph can cluster it under that course instead of leaving it unlinked."""
    for f in facts:
        predicate = str(f.get("predicate") or f.get("relation") or "")
        obj = str(f.get("object") or f.get("target") or "")
        course_id = clusters.get(f"{predicate}:{obj}"[:300])
        if course_id is not None:
            f["course_id"] = course_id
    return facts


def _review_stats(db: Session, user_id: int) -> dict:
    cards = db.scalars(select(ReviewCard).where(ReviewCard.user_id == user_id)).all()
    reps = sum(c.reps for c in cards)
    lapses = sum(c.lapses for c in cards)
    return {
        "cards": len(cards),
        "due": reviews.due_count(db, user_id),
        "reviews": reps,
        # delayed-recall success: the most honest measure of what actually stuck
        "retention": round(1 - lapses / reps, 2) if reps else None,
    }


@router.post("/profile/refresh")
async def refresh_profile(user: User = Depends(current_user)):
    spawn(update_profile(user.id))
    return {"ok": True}


@router.get("/notes")
def list_notes(course_id: int | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    stmt = select(Note).where(Note.user_id == user.id)
    if course_id is not None:
        stmt = stmt.where(Note.course_id == course_id)
    return [note_json(n) for n in db.scalars(stmt.order_by(Note.updated_at.desc())).all()]


@router.post("/notes")
def create_note(body: NoteIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = Note(user_id=user.id, title=body.title, content=body.content, course_id=body.course_id, node_id=body.node_id)
    db.add(n)
    db.commit()
    return note_json(n)


@router.patch("/notes/{note_id}")
def patch_note(note_id: int, body: NotePatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(404, "Заметка не найдена")
    if body.title is not None:
        n.title = body.title
    if body.content is not None:
        n.content = body.content
    db.commit()
    return note_json(n)


@router.delete("/notes/{note_id}")
def delete_note(note_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(404, "Заметка не найдена")
    db.delete(n)
    db.commit()
    return {"ok": True}


# ---------- spaced repetition ----------


class GradeIn(BaseModel):
    grade: str = Field(pattern="^(again|hard|good|easy)$")
    answer: str = ""


@router.get("/reviews")
def due_reviews(course_id: int | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    cards = reviews.due_cards(db, user.id, course_id=course_id)
    titles = {n.id: n.title for n in db.scalars(select(GraphNode).where(GraphNode.id.in_({c.node_id for c in cards}))).all()}
    return {
        "due": reviews.due_count(db, user.id),
        "cards": [
            {"id": c.id, "question": c.question, "answer": c.answer, "box": c.box, "node_title": titles.get(c.node_id, ""),
             "course_id": c.course_id}
            for c in cards
        ],  # fmt: skip
    }


@router.post("/reviews/{card_id}/grade")
def grade_review(card_id: int, body: GradeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    card = db.get(ReviewCard, card_id)
    if card is None or card.user_id != user.id:
        raise HTTPException(404, "Карточка не найдена")
    reviews.grade_card(card, body.grade)
    db.add(Event(user_id=user.id, node_id=card.node_id, stage="review", type="review_grade", target=f"card:{card.id}",
                 data={"grade": body.grade, "answer": body.answer[:1000], "box": card.box}))  # fmt: skip
    db.commit()
    return {"ok": True, "box": card.box, "due_at": card.due_at.isoformat()}
