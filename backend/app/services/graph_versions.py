"""History of the author's graph.

A rebuild replaces the live graph, so the graph it replaces is archived first: the author can look at
every variant the course ever had, while only the newest (live) one is actual. Learners never see the
old ones, and they carry no progress — progress belongs to the live topics only.
"""

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Course, GraphEdge, GraphNode, GraphVersion


def snapshot(db: Session, course_id: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The author's graph (topics + hard prerequisites) as plain data, ready to be stored in JSON.

    Personal bridges and side quests are not part of it: they belong to one learner, not to the course.
    """
    nodes = list(
        db.scalars(
            select(GraphNode)
            .where(GraphNode.course_id == course_id, GraphNode.owner_user_id.is_(None))
            .order_by(GraphNode.order_index, GraphNode.id)
        ).all()
    )
    ids = {n.id for n in nodes}
    edges = [
        {"source": e.src_id, "target": e.dst_id}
        for e in db.scalars(select(GraphEdge).where(GraphEdge.course_id == course_id)).all()
        if e.src_id in ids and e.dst_id in ids
    ]
    return (
        [
            {
                "id": n.id,
                "key": n.key,
                "title": n.title,
                "summary": n.summary,
                "objectives": n.objectives,
                "concepts": n.concepts,
                "order_index": n.order_index,
                "pinned": n.pinned,
            }
            for n in nodes
        ],
        edges,
    )


def next_number(db: Session, course_id: int) -> int:
    """The ordinal the live graph carries: 1 for the first graph, then one past the last archived one."""
    last = db.scalar(select(func.max(GraphVersion.version)).where(GraphVersion.course_id == course_id)) or 0
    return int(last) + 1


def archive(db: Session, course: Course, reason: str) -> GraphVersion | None:
    """Save the graph that is about to be replaced by a rebuild. An empty graph has nothing worth keeping."""
    nodes, edges = snapshot(db, course.id)
    if not nodes:
        return None
    row = GraphVersion(
        course_id=course.id,
        version=next_number(db, course.id),
        reason=reason,
        summary=course.summary,
        nodes=nodes,
        edges=edges,
    )
    db.add(row)
    return row
