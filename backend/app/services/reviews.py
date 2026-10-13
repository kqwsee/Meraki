"""Spaced retrieval practice with Leitner boxes.

Cards come from each lecture's summary. A learner answers from memory first (retrieval),
then sees the reference answer and grades themselves; the grade moves the card between boxes.
"""

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import GraphEdge, GraphNode, ReviewCard, utcnow

BOX_DAYS = [1, 2, 4, 8, 16, 32, 64]
GRADES = ("again", "hard", "good", "easy")


def add_cards(db: Session, user_id: int, course_id: int, node_id: int, cards: list[dict[str, str]]) -> None:
    first_due = utcnow() + timedelta(days=1)
    for c in cards[:8]:
        q, a = str(c.get("question", "")).strip(), str(c.get("answer", "")).strip()
        if q and a:
            db.add(ReviewCard(user_id=user_id, course_id=course_id, node_id=node_id, question=q, answer=a, due_at=first_due))


def grade_card(card: ReviewCard, grade: str) -> None:
    now = utcnow()
    card.reps += 1
    card.last_reviewed_at = now
    if grade == "again":
        card.lapses += 1
        card.box = 0
        card.due_at = now + timedelta(minutes=10)
        return
    if grade == "hard":
        card.box = max(card.box, 0)
        days = BOX_DAYS[card.box] * 0.6
    elif grade == "easy":
        card.box = min(card.box + 2, len(BOX_DAYS) - 1)
        days = BOX_DAYS[card.box]
    else:
        card.box = min(card.box + 1, len(BOX_DAYS) - 1)
        days = BOX_DAYS[card.box]
    card.due_at = now + timedelta(days=days)


def due_cards(db: Session, user_id: int, limit: int = 20, course_id: int | None = None) -> list[ReviewCard]:
    stmt = select(ReviewCard).where(ReviewCard.user_id == user_id, ReviewCard.due_at <= utcnow())
    if course_id is not None:
        stmt = stmt.where(ReviewCard.course_id == course_id)
    return list(db.scalars(stmt.order_by(ReviewCard.due_at).limit(limit)).all())


def due_count(db: Session, user_id: int) -> int:
    return db.scalar(
        select(func.count()).select_from(ReviewCard).where(ReviewCard.user_id == user_id, ReviewCard.due_at <= utcnow())
    ) or 0


def warmup_card(db: Session, user_id: int, node: GraphNode) -> ReviewCard | None:
    """A card from a prerequisite topic to open the prologue with (interleaved spaced retrieval)."""
    prereq = db.scalars(select(GraphEdge.src_id).where(GraphEdge.dst_id == node.id)).all()
    stmt = select(ReviewCard).where(ReviewCard.user_id == user_id, ReviewCard.course_id == node.course_id)
    if prereq:
        stmt = stmt.where(ReviewCard.node_id.in_(prereq))
    else:
        stmt = stmt.where(ReviewCard.node_id != node.id)
    return db.scalar(stmt.order_by(ReviewCard.due_at).limit(1))
