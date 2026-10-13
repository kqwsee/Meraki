from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..background import spawn
from ..db import get_db
from ..models import Course, CourseMaterial, Enrollment, GraphEdge, GraphNode, LearnerPath, NodeProgress, User
from ..prompts import DOMAINS, TOOL_CATALOG
from ..security import current_user, require_author
from ..services import materials
from ..services.context import course_progress
from ..services.course_builder import build_course_graph
from ..services.fetcher import fetch_material
from ..services.learning import completed_node_ids
from ..services import path as route

router = APIRouter(prefix="/api", tags=["courses"])

MAX_UPLOAD = 40 * 1024 * 1024


class CourseIn(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    description: str = ""
    domain: str = "general"


class CoursePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    domain: str | None = None
    tools: list[str] | None = None


class NodePatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    objectives: list[str] | None = None
    concepts: list[str] | None = None


def course_json(db: Session, c: Course, user: User) -> dict:
    enrolled = db.scalar(select(Enrollment).where(Enrollment.user_id == user.id, Enrollment.course_id == c.id)) is not None
    return {
        "id": c.id, "title": c.title, "description": c.description, "domain": c.domain,
        "domain_name": DOMAINS.get(c.domain, c.domain), "status": c.status, "status_detail": c.status_detail,
        "summary": c.summary, "tools": c.tools, "published": c.published, "author": c.author.name,
        "is_author": c.author_id == user.id, "enrolled": enrolled,
        "nodes_count": sum(1 for n in c.nodes if n.owner_user_id is None),
        "progress": course_progress(db, user.id, c.id) if enrolled else 0,
    }  # fmt: skip


def _own_course(db: Session, course_id: int, user: User) -> Course:
    course = db.get(Course, course_id)
    if course is None:
        raise HTTPException(404, "Курс не найден")
    if course.author_id != user.id:
        raise HTTPException(403, "Это не ваш курс")
    return course


def _visible_course(db: Session, course_id: int, user: User) -> Course:
    course = db.get(Course, course_id)
    if course is None or (course.author_id != user.id and not course.published):
        raise HTTPException(404, "Курс не найден")
    return course


@router.get("/meta")
def meta():
    return {"domains": DOMAINS, "tools": TOOL_CATALOG}


@router.get("/courses")
def list_courses(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Course).where(or_(Course.published.is_(True), Course.author_id == user.id)).order_by(Course.id.desc())
    ).all()
    return [course_json(db, c, user) for c in rows]


@router.post("/courses")
def create_course(body: CourseIn, user: User = Depends(require_author), db: Session = Depends(get_db)):
    course = Course(author_id=user.id, title=body.title.strip(), description=body.description,
                    domain=body.domain if body.domain in DOMAINS else "general")  # fmt: skip
    db.add(course)
    db.commit()
    return course_json(db, course, user)


@router.get("/courses/{course_id}")
def get_course(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _visible_course(db, course_id, user)
    done = completed_node_ids(db, user.id, course_id)
    stages = dict(
        db.execute(
            select(NodeProgress.node_id, NodeProgress.stage)
            .join(GraphNode, GraphNode.id == NodeProgress.node_id)
            .where(GraphNode.course_id == course_id, NodeProgress.user_id == user.id)
        ).all()
    )
    edges = db.scalars(select(GraphEdge).where(GraphEdge.course_id == course_id)).all()
    prereq = route.hard_prereqs(db, course_id)
    nodes = route.visible_nodes(db, course_id, user.id)
    enrolled = db.scalar(select(Enrollment).where(Enrollment.user_id == user.id, Enrollment.course_id == course_id)) is not None
    view = route.route_view(db, user.id, course_id) if enrolled else {"order": [n.id for n in nodes], "modes": {}, "message": "", "replans": 0}
    db.commit()
    rank = {nid: i for i, nid in enumerate(view["order"])}
    next_id = next((nid for nid in view["order"] if nid not in done and prereq.get(nid, set()) <= done), None)
    return {
        **course_json(db, course, user),
        "materials": [{"id": m.id, "filename": m.filename, "kind": m.kind, "chars": m.chars} for m in course.materials],
        "nodes": [
            {
                "id": n.id, "key": n.key, "title": n.title, "summary": n.summary, "objectives": n.objectives,
                "concepts": n.concepts, "completed": n.id in done, "stage": stages.get(n.id),
                "unlocked": n.owner_user_id is not None or prereq.get(n.id, set()) <= done,
                "personal": n.owner_user_id is not None, "rank": rank.get(n.id),
                "mode": "bridge" if n.owner_user_id else (view["modes"].get(str(n.id)) or {}).get("mode", "standard"),
                "mode_reason": (view["modes"].get(str(n.id)) or {}).get("reason", ""),
            }  # fmt: skip
            for n in nodes
        ],
        "edges": [{"source": e.src_id, "target": e.dst_id} for e in edges],
        "route": {"message": view["message"], "replans": view["replans"], "next_node_id": next_id},
    }


@router.patch("/courses/{course_id}")
def patch_course(course_id: int, body: CoursePatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _own_course(db, course_id, user)
    if body.title is not None:
        course.title = body.title
    if body.description is not None:
        course.description = body.description
    if body.domain is not None and body.domain in DOMAINS:
        course.domain = body.domain
    if body.tools is not None:
        course.tools = [t for t in body.tools if t in TOOL_CATALOG]
    db.commit()
    return course_json(db, course, user)


@router.delete("/courses/{course_id}")
def delete_course(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _own_course(db, course_id, user)
    for m in list(course.materials):
        materials.delete_material(db, m)
    db.delete(course)
    db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/materials")
async def upload_materials(
    course_id: int,
    kind: str = Form("textbook"),
    files: list[UploadFile] = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    course = _own_course(db, course_id, user)
    if kind not in ("textbook", "tasks", "other"):
        kind = "other"
    added = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"Файл {f.filename} больше 40 МБ")
        try:
            content = materials.extract_text(f.filename or "file.txt", data)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if not content.strip():
            raise HTTPException(400, f"Не удалось извлечь текст из {f.filename} (скан без текстового слоя?)")
        m = materials.add_material(db, course.id, f.filename or "file", kind, content)
        added.append({"id": m.id, "filename": m.filename, "kind": m.kind, "chars": m.chars})
    db.commit()
    return added


class UrlIn(BaseModel):
    url: str
    kind: str = "textbook"


class TextIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=20)
    kind: str = "textbook"


def _kind(kind: str) -> str:
    return kind if kind in ("textbook", "tasks", "other") else "other"


@router.post("/courses/{course_id}/materials/url")
async def add_material_url(course_id: int, body: UrlIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _own_course(db, course_id, user)
    try:
        name, content = await fetch_material(body.url.strip())
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Не удалось загрузить материал: {e}")
    if len(content.strip()) < 50:
        raise HTTPException(400, "По ссылке не нашлось текста")
    m = materials.add_material(db, course.id, f"{name} ({body.url.strip()[:120]})", _kind(body.kind), content)
    db.commit()
    return {"id": m.id, "filename": m.filename, "kind": m.kind, "chars": m.chars}


@router.post("/courses/{course_id}/materials/text")
def add_material_text(course_id: int, body: TextIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _own_course(db, course_id, user)
    m = materials.add_material(db, course.id, body.title.strip(), _kind(body.kind), body.text)
    db.commit()
    return {"id": m.id, "filename": m.filename, "kind": m.kind, "chars": m.chars}


@router.delete("/courses/{course_id}/materials/{material_id}")
def delete_material(course_id: int, material_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    m = db.get(CourseMaterial, material_id)
    if m is None or m.course_id != course_id:
        raise HTTPException(404, "Материал не найден")
    materials.delete_material(db, m)
    db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/build")
async def build(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _own_course(db, course_id, user)
    if course.status == "processing":
        raise HTTPException(409, "Граф уже строится")
    course.status, course.status_detail = "processing", "В очереди…"
    db.commit()
    spawn(build_course_graph(course_id))
    return {"ok": True}


@router.post("/courses/{course_id}/publish")
def publish(course_id: int, published: bool = True, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _own_course(db, course_id, user)
    if published and course.status != "ready":
        raise HTTPException(400, "Сначала постройте граф знаний")
    course.published = published
    db.commit()
    return course_json(db, course, user)


@router.post("/courses/{course_id}/enroll")
def enroll(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    course = _visible_course(db, course_id, user)
    if course.status != "ready":
        raise HTTPException(400, "Курс ещё не готов")
    if db.scalar(select(Enrollment).where(Enrollment.user_id == user.id, Enrollment.course_id == course_id)) is None:
        db.add(Enrollment(user_id=user.id, course_id=course_id))
        route.ensure_path(db, user.id, course_id)
        db.commit()
    return {"ok": True}


@router.patch("/nodes/{node_id}")
def patch_node(node_id: int, body: NodePatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    node = db.get(GraphNode, node_id)
    if node is None:
        raise HTTPException(404, "Тема не найдена")
    _own_course(db, node.course_id, user)
    for field in ("title", "summary", "objectives", "concepts"):
        value = getattr(body, field)
        if value is not None:
            setattr(node, field, value)
    db.commit()
    return {"ok": True}


@router.delete("/nodes/{node_id}")
def delete_node(node_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    node = db.get(GraphNode, node_id)
    if node is None:
        raise HTTPException(404, "Тема не найдена")
    _own_course(db, node.course_id, user)
    # keep the graph connected: link this node's prerequisites to its dependants
    ins = db.scalars(select(GraphEdge).where(GraphEdge.dst_id == node_id)).all()
    outs = db.scalars(select(GraphEdge).where(GraphEdge.src_id == node_id)).all()
    for i in ins:
        for o in outs:
            db.add(GraphEdge(course_id=node.course_id, src_id=i.src_id, dst_id=o.dst_id))
    for e in [*ins, *outs]:
        db.delete(e)
    db.delete(node)
    db.commit()
    return {"ok": True}
