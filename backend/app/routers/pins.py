"""Course materials as the author reads them, and the passages the author pins as mandatory for a topic."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import CourseMaterial, PinnedExcerpt, User
from ..security import current_user
from ..services import materials, pins
from .courses import _author_node, _own_course

router = APIRouter(prefix="/api", tags=["pins"])


class MaterialPatch(BaseModel):
    kind: str | None = None
    filename: str | None = Field(default=None, min_length=1, max_length=255)


class ExcerptIn(BaseModel):
    node_id: int | None = None
    material_id: int | None = None
    kind: str = "topic"  # topic | task
    use_in: str = "practice"  # tasks only
    title: str = ""
    content: str
    char_start: int | None = None
    char_end: int | None = None


class ExcerptPatch(BaseModel):
    node_id: int | None = None
    kind: str | None = None
    use_in: str | None = None
    title: str | None = Field(default=None, max_length=200)
    content: str | None = None


class ExcerptOrder(BaseModel):
    ids: list[int]


def _material(db: Session, course_id: int, material_id: int) -> CourseMaterial:
    m = db.get(CourseMaterial, material_id)
    if m is None or m.course_id != course_id:
        raise HTTPException(404, "Материал не найден")
    return m


def _excerpt(db: Session, excerpt_id: int, user: User) -> PinnedExcerpt:
    e = db.get(PinnedExcerpt, excerpt_id)
    if e is None:
        raise HTTPException(404, "Фрагмент не найден")
    _own_course(db, e.course_id, user)
    return e


def _clean(kind: str, content: str) -> str:
    text = pins.tidy(content)
    if not text:
        raise HTTPException(400, "Пустой фрагмент")
    limit = pins.MAX_TASK_CHARS if kind == "task" else pins.MAX_TOPIC_CHARS
    if len(text) > limit:
        what = "задание" if kind == "task" else "тему"
        raise HTTPException(400, f"Фрагмент слишком большой ({len(text)} знаков, максимум {limit}). Закрепите {what} по частям.")
    return text


def _use_in(kind: str, use_in: str) -> str:
    if kind != "task":
        return ""
    return use_in if use_in in pins.USE_IN else "practice"


@router.get("/courses/{course_id}/materials/{material_id}/text")
def material_text(course_id: int, material_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    m = _material(db, course_id, material_id)
    text = materials.material_text(db, m)
    db.commit()
    return {"id": m.id, "filename": m.filename, "kind": m.kind, "text": text}


@router.patch("/courses/{course_id}/materials/{material_id}")
def patch_material(course_id: int, material_id: int, body: MaterialPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    m = _material(db, course_id, material_id)
    if body.kind is not None:
        materials.set_kind(db, m, body.kind if body.kind in ("textbook", "tasks", "other") else "other")
    if body.filename is not None:
        m.filename = body.filename.strip() or m.filename
    db.commit()
    return {"id": m.id, "filename": m.filename, "kind": m.kind, "chars": m.chars}


@router.get("/courses/{course_id}/excerpts")
def list_excerpts(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    rows = db.scalars(
        select(PinnedExcerpt).where(PinnedExcerpt.course_id == course_id).order_by(PinnedExcerpt.position, PinnedExcerpt.id)
    ).all()
    return {"items": [pins.excerpt_json(e) for e in rows], "limits": pins.LIMITS}


@router.post("/courses/{course_id}/excerpts")
def create_excerpt(course_id: int, body: ExcerptIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    if body.kind not in pins.KINDS:
        raise HTTPException(400, "Неизвестный тип фрагмента")
    if body.node_id is not None:
        _author_node(db, course_id, body.node_id)
    source = ""
    if body.material_id is not None:
        source = _material(db, course_id, body.material_id).filename
    content = _clean(body.kind, body.content)
    if body.char_start is not None and body.char_end is not None:
        twin = db.scalar(
            select(PinnedExcerpt.id).where(
                PinnedExcerpt.course_id == course_id, PinnedExcerpt.node_id == body.node_id, PinnedExcerpt.kind == body.kind,
                PinnedExcerpt.material_id == body.material_id, PinnedExcerpt.char_start == body.char_start, PinnedExcerpt.char_end == body.char_end,
            )
        )
        if twin is not None:
            raise HTTPException(409, "Этот фрагмент уже закреплён за темой")
    last = db.scalar(
        select(func.max(PinnedExcerpt.position)).where(PinnedExcerpt.node_id == body.node_id, PinnedExcerpt.kind == body.kind)
    )
    e = PinnedExcerpt(
        course_id=course_id, node_id=body.node_id, material_id=body.material_id, source=source, kind=body.kind,
        use_in=_use_in(body.kind, body.use_in), title=(body.title.strip() or pins.auto_title(content))[:200], content=content,
        char_start=body.char_start, char_end=body.char_end, position=(last + 1) if last is not None else 0,
    )  # fmt: skip
    db.add(e)
    db.commit()
    return pins.excerpt_json(e)


@router.patch("/excerpts/{excerpt_id}")
def patch_excerpt(excerpt_id: int, body: ExcerptPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = _excerpt(db, excerpt_id, user)
    if body.node_id is not None and body.node_id != e.node_id:
        _author_node(db, e.course_id, body.node_id)
        e.node_id = body.node_id
    if body.kind is not None:
        if body.kind not in pins.KINDS:
            raise HTTPException(400, "Неизвестный тип фрагмента")
        e.kind = body.kind
    if body.use_in is not None:
        e.use_in = body.use_in
    e.use_in = _use_in(e.kind, e.use_in)
    if body.content is not None:
        e.content = _clean(e.kind, body.content)
        e.char_start = e.char_end = None  # edited text no longer matches the source, so it is not highlighted there
    elif body.kind is not None:
        _clean(e.kind, e.content)  # the stored text must also fit the limit of the new kind
    if body.title is not None:
        e.title = body.title.strip() or pins.auto_title(e.content)
    db.commit()
    return pins.excerpt_json(e)


@router.delete("/excerpts/{excerpt_id}")
def delete_excerpt(excerpt_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = _excerpt(db, excerpt_id, user)
    db.delete(e)
    db.commit()
    return {"ok": True}


@router.put("/courses/{course_id}/excerpts/order")
def order_excerpts(course_id: int, body: ExcerptOrder, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The order of the author's passages inside a topic: the lecture goes through the topics in this order."""
    _own_course(db, course_id, user)
    rows = {e.id: e for e in db.scalars(select(PinnedExcerpt).where(PinnedExcerpt.course_id == course_id)).all()}
    for i, eid in enumerate(i for i in dict.fromkeys(body.ids) if i in rows):
        rows[eid].position = i
    db.commit()
    return {"ok": True}
