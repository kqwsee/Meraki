"""Lecture visuals and course pictures: the author drafts (with the AI), checks and orders them in the course editor;
learners get the approved ones in the lecture."""

from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..llm import LLMError
from ..models import Course, CourseAsset, GraphNode, TopicVisual, User
from ..security import current_user
from ..services import assets
from ..services import visuals as service
from .courses import _author_node, _own_course

router = APIRouter(prefix="/api", tags=["visuals"])


class VisualIn(BaseModel):
    node_id: int | None = None
    kind: str
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=2000)
    code: str = ""
    data: dict[str, Any] = {}
    asset_id: int | None = None
    approve: bool = True  # the author's own visual is checked by definition


class VisualPatch(BaseModel):
    node_id: int | None = None
    kind: str | None = None
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    code: str | None = None
    data: dict[str, Any] | None = None
    asset_id: int | None = None
    status: str | None = None


class GenerateIn(BaseModel):
    wishes: str = Field(default="", max_length=2000)


class GenerateAllIn(BaseModel):
    node_ids: list[int] | None = None  # None = every topic that has no AI drafts yet


class RedoIn(BaseModel):
    feedback: str = Field(default="", max_length=4000)


class OrderIn(BaseModel):
    ids: list[int]


class ApproveAllIn(BaseModel):
    node_id: int


class CoverIn(BaseModel):
    asset_id: int | None = None


class QueriesIn(BaseModel):
    queries: list[str] = Field(default=[], max_length=5)


class ImportIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    title: str = Field(default="", max_length=300)
    license: str = Field(default="", max_length=120)
    author: str = Field(default="", max_length=300)
    page_url: str = Field(default="", max_length=1000)


def _visual(db: Session, visual_id: int, user: User) -> TopicVisual:
    v = db.get(TopicVisual, visual_id)
    if v is None:
        raise HTTPException(404, "Материал не найден")
    _own_course(db, v.course_id, user)
    return v


def _asset(db: Session, course_id: int, asset_id: int) -> CourseAsset:
    a = db.get(CourseAsset, asset_id)
    if a is None or a.course_id != course_id:
        raise HTTPException(404, "Картинка не найдена")
    return a


def _check(kind: str, code: str, data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if kind not in service.KINDS:
        raise HTTPException(400, "Неизвестный вид наглядного материала")
    try:
        return service.clean(kind, code, data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _one(db: Session, v: TopicVisual) -> dict[str, Any]:
    return service.with_assets(db, [v])[0]


# ---------- the author's side ----------


@router.get("/courses/{course_id}/visuals")
def list_visuals(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    nodes = list(db.scalars(select(GraphNode).where(GraphNode.course_id == course_id, GraphNode.owner_user_id.is_(None))).all())
    covers = assets.cover_urls(db, nodes)
    return {
        "items": service.with_assets(db, service.course_visuals(db, course_id)),
        "job": service.job_state(course_id),
        "image_queries": {n.id: n.image_queries for n in nodes if n.image_queries},
        "covers": {n.id: {"asset_id": n.cover_asset_id, "url": covers[n.id]} for n in nodes if n.id in covers},
    }


@router.post("/courses/{course_id}/visuals")
def create_visual(course_id: int, body: VisualIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    if body.node_id is not None:
        _author_node(db, course_id, body.node_id)
    code, data = _check(body.kind, body.code, body.data)
    if body.kind == "image":
        if body.asset_id is None:
            raise HTTPException(400, "Выберите картинку")
        _asset(db, course_id, body.asset_id)
    if body.node_id is not None and len(service.node_visuals(db, body.node_id)) >= service.MAX_PER_NODE:
        raise HTTPException(400, f"У темы может быть не больше {service.MAX_PER_NODE} наглядных материалов")
    v = TopicVisual(
        course_id=course_id, node_id=body.node_id, kind=body.kind, title=body.title.strip(), description=body.description.strip(),
        code=code, data=data, asset_id=body.asset_id if body.kind == "image" else None, origin="author", status="draft",
        position=service.next_position(db, body.node_id),
    )  # fmt: skip
    if body.approve and service.approvable(v) is None:
        v.status = "approved"
    db.add(v)
    db.commit()
    return _one(db, v)


@router.patch("/visuals/{visual_id}")
def patch_visual(visual_id: int, body: VisualPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    v = _visual(db, visual_id, user)
    if body.node_id is not None and body.node_id != v.node_id:
        _author_node(db, v.course_id, body.node_id)
        v.node_id = body.node_id
        v.position = service.next_position(db, body.node_id)
    kind = body.kind if body.kind is not None else v.kind
    if body.kind is not None or body.code is not None or body.data is not None:
        v.code, v.data = _check(kind, body.code if body.code is not None else v.code, body.data if body.data is not None else v.data)
        v.kind = kind
    if body.asset_id is not None:
        _asset(db, v.course_id, body.asset_id)
        v.asset_id = body.asset_id
    if body.title is not None:
        v.title = body.title.strip()
    if body.description is not None:
        v.description = body.description.strip()
    if body.status is not None:
        if body.status not in service.STATUSES:
            raise HTTPException(400, "Неизвестный статус")
        if body.status == "approved":
            why = service.approvable(v)
            if why:
                raise HTTPException(400, why)
        v.status = body.status
    elif v.status == "approved" and service.approvable(v):
        v.status = "draft"  # the edit made it unfit to show
    db.commit()
    return _one(db, v)


@router.delete("/visuals/{visual_id}")
def delete_visual(visual_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    v = _visual(db, visual_id, user)
    db.delete(v)
    db.commit()
    return {"ok": True}


@router.put("/courses/{course_id}/visuals/order")
def order_visuals(course_id: int, body: OrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The order inside a topic: the order the author expects them in the lecture."""
    _own_course(db, course_id, user)
    rows = {v.id: v for v in service.course_visuals(db, course_id)}
    for i, vid in enumerate(i for i in dict.fromkeys(body.ids) if i in rows):
        rows[vid].position = i
    db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/visuals/approve")
def approve_all(course_id: int, body: ApproveAllIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Approves every draft of a topic that can be shown (pictures without a description stay drafts)."""
    _own_course(db, course_id, user)
    _author_node(db, course_id, body.node_id)
    approved, skipped = 0, 0
    for v in service.node_visuals(db, body.node_id):
        if v.status == "approved":
            continue
        if service.approvable(v):
            skipped += 1
            continue
        v.status = "approved"
        approved += 1
    db.commit()
    return {"approved": approved, "skipped": skipped}


@router.post("/nodes/{node_id}/visuals/generate")
async def generate_visuals(node_id: int, body: GenerateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The AI drafts visuals for one topic; they wait unapproved for the author's check."""
    node = db.get(GraphNode, node_id)
    if node is None:
        raise HTTPException(404, "Тема не найдена")
    _own_course(db, node.course_id, user)
    _author_node(db, node.course_id, node_id)
    try:
        ids = await service.generate_for_node(node_id, body.wishes)
    except LLMError as e:
        raise HTTPException(502, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    db.expire_all()
    rows = [v for v in service.node_visuals(db, node_id) if v.id in set(ids)]
    return {"items": service.with_assets(db, rows), "image_queries": db.get(GraphNode, node_id).image_queries}


@router.post("/courses/{course_id}/visuals/generate-all")
async def generate_all(course_id: int, body: GenerateAllIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Drafts visuals for many topics in the background; the editor polls GET /visuals for the progress.
    Async on purpose: the job is spawned on the running event loop."""
    _own_course(db, course_id, user)
    nodes = db.scalars(
        select(GraphNode).where(GraphNode.course_id == course_id, GraphNode.owner_user_id.is_(None)).order_by(GraphNode.order_index, GraphNode.id)
    ).all()
    if body.node_ids is not None:
        wanted = set(body.node_ids)
        ids = [n.id for n in nodes if n.id in wanted]
    else:
        drafted = set(db.scalars(select(TopicVisual.node_id).where(TopicVisual.course_id == course_id, TopicVisual.origin == "ai")).all())
        ids = [n.id for n in nodes if n.id not in drafted]
    if not ids:
        raise HTTPException(400, "Все темы уже с наглядностью. Для отдельной темы нажмите «Подготовить с ИИ» в её карточке")
    try:
        return service.start_bulk(course_id, ids)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.post("/visuals/{visual_id}/regenerate")
async def regenerate_visual(visual_id: int, body: RedoIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Rewrites one visual from the author's remarks; it goes back to the drafts."""
    v = _visual(db, visual_id, user)
    if v.kind == "image":
        raise HTTPException(400, "Картинки ИИ не переделывает: замените файл или поправьте описание")
    try:
        item = await service.regenerate(v, body.feedback)
    except LLMError as e:
        raise HTTPException(502, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    db.expire_all()  # the author may have edited it while the model was thinking
    v = _visual(db, visual_id, user)
    for field, value in item.items():
        setattr(v, field, value)
    v.status = "draft"
    db.commit()
    return _one(db, v)


@router.put("/nodes/{node_id}/cover")
def set_cover(node_id: int, body: CoverIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    node = db.get(GraphNode, node_id)
    if node is None:
        raise HTTPException(404, "Тема не найдена")
    _own_course(db, node.course_id, user)
    _author_node(db, node.course_id, node_id)
    if body.asset_id is not None:
        _asset(db, node.course_id, body.asset_id)
    node.cover_asset_id = body.asset_id
    db.commit()
    return {"ok": True, "url": assets.cover_urls(db, [node]).get(node.id)}


@router.put("/nodes/{node_id}/image-queries")
def set_image_queries(node_id: int, body: QueriesIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The author drops a picture search the AI suggested and that does not fit the topic."""
    node = db.get(GraphNode, node_id)
    if node is None:
        raise HTTPException(404, "Тема не найдена")
    _own_course(db, node.course_id, user)
    node.image_queries = [q.strip()[:120] for q in body.queries if q.strip()]
    db.commit()
    return {"image_queries": node.image_queries}


# ---------- pictures ----------


@router.get("/assets/{key}", include_in_schema=False)
def asset_file(key: str, db: Session = Depends(get_db)):
    """Public on purpose: <img> cannot send the token, and the key is random."""
    a = db.scalar(select(CourseAsset).where(CourseAsset.key == key))
    if a is None or not assets.file_path(a).is_file():
        raise HTTPException(404, "Картинка не найдена")
    return FileResponse(
        assets.file_path(a), media_type=a.mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
                 "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"},
    )  # fmt: skip


@router.get("/courses/{course_id}/assets")
def list_assets(course_id: int, source: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    used = assets.usage(db, course_id)
    return {"items": [assets.asset_json(a, used.get(a.id, 0)) for a in assets.course_assets(db, course_id, source)]}


@router.post("/courses/{course_id}/assets")
async def upload_assets(course_id: int, files: list[UploadFile] = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    out = []
    for f in files:
        data = await f.read(assets.MAX_BYTES + 1)
        try:
            a, _ = assets.save_image(db, course_id, data, filename=f.filename or "picture", source="upload")
        except ValueError as e:
            db.rollback()
            raise HTTPException(400, f"{f.filename}: {e}") from e
        out.append(a)
    db.commit()
    used = assets.usage(db, course_id)
    return {"items": [assets.asset_json(a, used.get(a.id, 0)) for a in out]}


@router.delete("/assets/{asset_id}")
def delete_asset(asset_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = db.get(CourseAsset, asset_id)
    if a is None:
        raise HTTPException(404, "Картинка не найдена")
    _own_course(db, a.course_id, user)
    n = assets.usage(db, a.course_id).get(a.id, 0)
    if n:
        raise HTTPException(409, f"Картинка используется ({n}): сначала уберите её из наглядных материалов и обложек")
    assets.delete_asset(db, a)
    db.commit()
    return {"ok": True}


@router.get("/courses/{course_id}/images/search")
async def search_images(course_id: int, q: str, source: str = "ru", user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(400, "Введите запрос")
    if source not in assets.WEB_SOURCES:
        raise HTTPException(400, "Источник: ru или en (русская или английская Википедия)")
    name = assets.WEB_SOURCE_NAMES[source]
    try:
        return {"items": await assets.search_web(source, q[:200])}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        if code in (401, 403):
            raise HTTPException(502, f"{name} отказал в доступе ({code}): библиотека не принимает запросы с этого сервера. Поищите в другом источнике") from e
        if code == 429:
            raise HTTPException(502, f"{name}: слишком много запросов, попробуйте через несколько минут") from e
        raise HTTPException(502, f"{name} ответил ошибкой {code}") from e
    except Exception as e:  # noqa: BLE001 - network errors of the library
        raise HTTPException(502, f"Поиск не удался: {e}") from e


@router.post("/courses/{course_id}/assets/import")
async def import_asset(course_id: int, body: ImportIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Copies a picture found in an open library into the course, with its license and author."""
    _own_course(db, course_id, user)
    try:
        a = await assets.import_web(
            db, course_id, image_url=body.url.strip(), title=body.title, license=body.license, author=body.author, page_url=body.page_url,
        )  # fmt: skip
    except ValueError as e:
        db.rollback()
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - network errors
        db.rollback()
        raise HTTPException(502, f"Не удалось скачать картинку: {e}") from e
    db.commit()
    return assets.asset_json(a, assets.usage(db, course_id).get(a.id, 0))


# ---------- the learner's side ----------


@router.get("/visuals/{visual_id}")
def get_visual(visual_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """One visual as the lecture shows it (notes keep markers of visuals, so they are fetched one by one)."""
    v = db.get(TopicVisual, visual_id)
    course = db.get(Course, v.course_id) if v else None
    if v is None or course is None:
        raise HTTPException(404, "Материал не найден")
    if course.author_id != user.id and not (course.published and v.status == "approved"):
        raise HTTPException(404, "Материал не найден")
    return _one(db, v)
