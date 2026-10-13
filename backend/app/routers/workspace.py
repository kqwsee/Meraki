"""Virtual workspace: per-learner, per-course files plus a canvas per node and stage."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Canvas, Enrollment, GraphNode, User, WorkspaceFile
from ..security import current_user

router = APIRouter(prefix="/api", tags=["workspace"])

MAX_FILE_CHARS = 2_000_000


class FileIn(BaseModel):
    path: str
    content: str = ""


class RenameIn(BaseModel):
    old: str
    new: str


class CanvasIn(BaseModel):
    scene: dict


def _clean(path: str) -> str:
    p = path.strip().replace("\\", "/").strip("/")
    parts = [s for s in p.split("/") if s not in ("", ".")]
    if not parts or any(s == ".." for s in parts) or len(p) > 400:
        raise HTTPException(400, "Некорректный путь")
    return "/".join(parts)


def _check_course(db: Session, user: User, course_id: int) -> None:
    if db.scalar(select(Enrollment).where(Enrollment.user_id == user.id, Enrollment.course_id == course_id)) is None:
        raise HTTPException(403, "Нет доступа к пространству этого курса")


def _get(db: Session, user: User, course_id: int, path: str) -> WorkspaceFile | None:
    return db.scalar(
        select(WorkspaceFile).where(WorkspaceFile.user_id == user.id, WorkspaceFile.course_id == course_id, WorkspaceFile.path == path)
    )


@router.get("/courses/{course_id}/files")
def list_files(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _check_course(db, user, course_id)
    rows = db.scalars(
        select(WorkspaceFile).where(WorkspaceFile.user_id == user.id, WorkspaceFile.course_id == course_id).order_by(WorkspaceFile.path)
    ).all()
    return [{"path": f.path, "size": len(f.content), "updated_at": f.updated_at.isoformat()} for f in rows]


@router.get("/courses/{course_id}/file")
def read_file(course_id: int, path: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _check_course(db, user, course_id)
    f = _get(db, user, course_id, _clean(path))
    if f is None:
        raise HTTPException(404, "Файл не найден")
    return {"path": f.path, "content": f.content}


@router.put("/courses/{course_id}/file")
def write_file(course_id: int, body: FileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _check_course(db, user, course_id)
    if len(body.content) > MAX_FILE_CHARS:
        raise HTTPException(413, "Файл слишком большой")
    path = _clean(body.path)
    f = _get(db, user, course_id, path)
    if f is None:
        f = WorkspaceFile(user_id=user.id, course_id=course_id, path=path, content=body.content)
        db.add(f)
    else:
        f.content = body.content
    db.commit()
    return {"path": f.path, "size": len(f.content)}


@router.delete("/courses/{course_id}/file")
def delete_file(course_id: int, path: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Deletes a file, or a whole folder when `path` is a folder prefix."""
    _check_course(db, user, course_id)
    path = _clean(path)
    rows = db.scalars(
        select(WorkspaceFile).where(WorkspaceFile.user_id == user.id, WorkspaceFile.course_id == course_id)
    ).all()
    removed = 0
    for f in rows:
        if f.path == path or f.path.startswith(path + "/"):
            db.delete(f)
            removed += 1
    db.commit()
    return {"removed": removed}


@router.post("/courses/{course_id}/rename")
def rename(course_id: int, body: RenameIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _check_course(db, user, course_id)
    old, new = _clean(body.old), _clean(body.new)
    rows = db.scalars(
        select(WorkspaceFile).where(WorkspaceFile.user_id == user.id, WorkspaceFile.course_id == course_id)
    ).all()
    existing = {f.path for f in rows}
    moved = 0
    for f in rows:
        if f.path == old or f.path.startswith(old + "/"):
            target = new + f.path[len(old) :]
            if target in existing:
                raise HTTPException(409, f"{target} уже существует")
            f.path = target
            moved += 1
    db.commit()
    return {"moved": moved}


def _canvas_node(db: Session, user: User, node_id: int) -> None:
    node = db.get(GraphNode, node_id)
    if node is None:
        raise HTTPException(404, "Тема не найдена")
    _check_course(db, user, node.course_id)


@router.get("/nodes/{node_id}/canvas/{stage}")
def get_canvas(node_id: int, stage: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _canvas_node(db, user, node_id)
    c = db.scalar(select(Canvas).where(Canvas.user_id == user.id, Canvas.node_id == node_id, Canvas.stage == stage))
    return {"scene": c.scene if c else None}


@router.put("/nodes/{node_id}/canvas/{stage}")
def put_canvas(node_id: int, stage: str, body: CanvasIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _canvas_node(db, user, node_id)
    if stage not in ("practice", "exam"):
        raise HTTPException(400, "Холст есть только в практике и экзамене")
    c = db.scalar(select(Canvas).where(Canvas.user_id == user.id, Canvas.node_id == node_id, Canvas.stage == stage))
    if c is None:
        c = Canvas(user_id=user.id, node_id=node_id, stage=stage, scene=body.scene)
        db.add(c)
    else:
        c.scene = body.scene
    db.commit()
    return {"ok": True}
