"""The course author's own tools (no-code formulas, HTML/JS, AI-made) — CRUD and generation."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..llm import LLMError
from ..models import CustomTool, User
from ..security import current_user
from ..services import custom_tools as service
from .courses import _own_course

router = APIRouter(prefix="/api", tags=["tools"])


class ToolIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    icon: str = "🧩"
    description: str = Field(default="", max_length=1000)
    kind: str
    spec: dict[str, Any] = {}
    code: str = ""
    origin: str = "manual"  # manual | ai
    prompt: str = Field(default="", max_length=4000)
    enabled: bool = True


class ToolPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    icon: str | None = None
    description: str | None = Field(default=None, max_length=1000)
    kind: str | None = None
    spec: dict[str, Any] | None = None
    code: str | None = None
    origin: str | None = None
    prompt: str | None = Field(default=None, max_length=4000)
    enabled: bool | None = None


class GenerateIn(BaseModel):
    prompt: str = Field(min_length=5, max_length=4000)
    previous: dict[str, Any] | None = None  # the tool being refined, as the editors hold it
    feedback: str = Field(default="", max_length=4000)


def _tool(db: Session, tool_id: int, user: User) -> CustomTool:
    t = db.get(CustomTool, tool_id)
    if t is None:
        raise HTTPException(404, "Инструмент не найден")
    _own_course(db, t.course_id, user)
    return t


def _check(kind: str, spec: dict[str, Any], code: str) -> tuple[dict[str, Any], str]:
    try:
        return service.clean_tool(kind, spec, code)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/courses/{course_id}/custom-tools")
def list_tools(course_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    return {"items": [service.tool_json(t) for t in service.course_tools(db, course_id)], "max": service.MAX_TOOLS}


@router.post("/courses/{course_id}/custom-tools")
def create_tool(course_id: int, body: ToolIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _own_course(db, course_id, user)
    if body.kind not in service.KINDS:
        raise HTTPException(400, "Неизвестный тип инструмента")
    if (db.scalar(select(func.count()).select_from(CustomTool).where(CustomTool.course_id == course_id)) or 0) >= service.MAX_TOOLS:
        raise HTTPException(400, f"В курсе может быть не больше {service.MAX_TOOLS} своих инструментов")
    spec, code = _check(body.kind, body.spec, body.code)
    last = db.scalar(select(func.max(CustomTool.position)).where(CustomTool.course_id == course_id))
    t = CustomTool(
        course_id=course_id, name=body.name.strip(), icon=(body.icon.strip() or "🧩")[:16], description=body.description.strip(),
        kind=body.kind, origin="ai" if body.origin == "ai" else "manual", spec=spec, code=code, prompt=body.prompt.strip(),
        enabled=body.enabled, position=(last + 1) if last is not None else 0,
    )  # fmt: skip
    db.add(t)
    db.commit()
    return service.tool_json(t)


@router.patch("/custom-tools/{tool_id}")
def patch_tool(tool_id: int, body: ToolPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = _tool(db, tool_id, user)
    kind = body.kind if body.kind is not None else t.kind
    if kind not in service.KINDS:
        raise HTTPException(400, "Неизвестный тип инструмента")
    if body.kind is not None or body.spec is not None or body.code is not None:
        t.spec, t.code = _check(kind, body.spec if body.spec is not None else t.spec, body.code if body.code is not None else t.code)
        t.kind = kind
    if body.name is not None:
        t.name = body.name.strip()
    if body.icon is not None:
        t.icon = (body.icon.strip() or "🧩")[:16]
    if body.description is not None:
        t.description = body.description.strip()
    if body.origin is not None:
        t.origin = "ai" if body.origin == "ai" else "manual"
    if body.prompt is not None:
        t.prompt = body.prompt.strip()
    if body.enabled is not None:
        t.enabled = body.enabled
    db.commit()
    return service.tool_json(t)


@router.delete("/custom-tools/{tool_id}")
def delete_tool(tool_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = _tool(db, tool_id, user)
    db.delete(t)
    db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/custom-tools/generate")
async def generate_tool(course_id: int, body: GenerateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The AI makes (or refines) a tool from the author's description. Nothing is saved: the author checks it first."""
    course = _own_course(db, course_id, user)
    try:
        return await service.generate(course, body.prompt, body.previous, body.feedback)
    except LLMError as e:
        raise HTTPException(502, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
