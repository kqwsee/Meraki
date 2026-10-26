"""The course author's own tools: validation, the shape sent to learners, and AI generation from a description.

Two kinds, both rendered in the browser (see frontend/src/tools/custom.tsx):
- `formula`: a no-code calculator. spec = {inputs: [...], outputs: [{key, expr, ...}], notes}; expressions are math.js.
- `html`: a self-contained HTML/JS page that runs in a sandboxed iframe. spec = {height}, code = the page.
"""

import json
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..llm import get_llm
from ..models import Course, CustomTool
from ..prompts import DOMAINS, TOOL_GEN_EDIT, TOOL_GEN_SCHEMA, TOOL_GEN_SYSTEM

KINDS = ("formula", "html")
MAX_TOOLS = 20  # per course
MAX_CODE = 120_000  # characters of one HTML page
MAX_FIELDS = 12  # inputs, and separately outputs, of one formula tool
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,23}$")
# names math.js treats as constants or syntax; function names (sin, max…) are caught by the browser preview
RESERVED = {"e", "i", "pi", "tau", "phi", "Infinity", "NaN", "null", "undefined", "true", "false", "end", "in", "to", "mod", "and", "or", "not", "xor"}
HEIGHT_RANGE = (160, 900)
DEFAULT_HEIGHT = 360


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and abs(n) != float("inf") else None


def _height(value: Any) -> int:
    try:
        return max(HEIGHT_RANGE[0], min(HEIGHT_RANGE[1], int(value)))
    except (TypeError, ValueError):
        return DEFAULT_HEIGHT


def clean_formula(spec: dict[str, Any]) -> dict[str, Any]:
    """The formula spec in its canonical form; raises ValueError with a message for the author."""
    inputs, outputs, used = [], [], set()

    def key_of(raw: Any, what: str) -> str:
        key = _text(raw, 24)
        if not KEY_RE.match(key):
            raise ValueError(f"{what}: обозначение «{key}» должно быть латиницей (буквы, цифры, _), начинаться с буквы, до 24 знаков")
        if key in RESERVED:
            raise ValueError(f"{what}: обозначение «{key}» занято (это константа или служебное слово)")
        if key in used:
            raise ValueError(f"Обозначение «{key}» встречается дважды")
        used.add(key)
        return key

    for raw in (spec.get("inputs") or [])[:MAX_FIELDS]:
        key = key_of(raw.get("key"), "Вводимая величина")
        item: dict[str, Any] = {"key": key, "label": _text(raw.get("label"), 80) or key, "unit": _text(raw.get("unit"), 20)}
        default = _number(raw.get("default"))
        item["default"] = default if default is not None else 0
        for bound in ("min", "max"):
            value = _number(raw.get(bound))
            if value is not None:
                item[bound] = value
        inputs.append(item)
    for raw in (spec.get("outputs") or [])[:MAX_FIELDS]:
        key = key_of(raw.get("key"), "Результат")
        expr = _text(raw.get("expr"), 500)
        if not expr:
            raise ValueError(f"У результата «{key}» нет формулы")
        decimals = raw.get("decimals")
        outputs.append({
            "key": key, "label": _text(raw.get("label"), 80) or key, "unit": _text(raw.get("unit"), 20), "expr": expr,
            "decimals": max(0, min(10, int(decimals))) if isinstance(decimals, (int, float)) and not isinstance(decimals, bool) else 2,
        })  # fmt: skip
    if not inputs:
        raise ValueError("Добавьте хотя бы одну вводимую величину")
    if not outputs:
        raise ValueError("Добавьте хотя бы один результат с формулой")
    return {"inputs": inputs, "outputs": outputs, "notes": _text(spec.get("notes"), 2000)}


def clean_tool(kind: str, spec: dict[str, Any], code: str) -> tuple[dict[str, Any], str]:
    """Validated (spec, code) for a tool of this kind."""
    if kind == "formula":
        return clean_formula(spec or {}), ""
    if kind == "html":
        code = (code or "").strip()
        if len(code) < 20 or "<" not in code:
            raise ValueError("Код инструмента пуст: напишите HTML-страницу или создайте её с ИИ")
        if len(code) > MAX_CODE:
            raise ValueError(f"Код слишком большой ({len(code)} знаков, максимум {MAX_CODE})")
        return {"height": _height((spec or {}).get("height"))}, code
    raise ValueError("Неизвестный тип инструмента")


def tool_json(t: CustomTool) -> dict[str, Any]:
    return {
        "id": t.id, "tool_id": f"custom_{t.id}", "name": t.name, "icon": t.icon, "description": t.description, "kind": t.kind,
        "origin": t.origin, "spec": t.spec, "code": t.code, "prompt": t.prompt, "enabled": t.enabled, "position": t.position,
    }  # fmt: skip


def course_tools(db: Session, course_id: int, enabled_only: bool = False) -> list[CustomTool]:
    stmt = select(CustomTool).where(CustomTool.course_id == course_id)
    if enabled_only:
        stmt = stmt.where(CustomTool.enabled.is_(True))
    return list(db.scalars(stmt.order_by(CustomTool.position, CustomTool.id)).all())


def tools_line(db: Session, course_id: int) -> str:
    """The author's tools for prompts: the tutor and the task writer may rely on them."""
    items = course_tools(db, course_id, enabled_only=True)
    return "; ".join(f"«{t.name}»" + (f" ({t.description[:140]})" if t.description else "") for t in items)


# ---------- AI generation ----------


def _previous_block(previous: dict[str, Any]) -> str:
    body = previous.get("code") if previous.get("kind") == "html" else json.dumps(previous.get("spec"), ensure_ascii=False)
    return f"## Текущий инструмент ({previous.get('kind')}): «{previous.get('name', '')}»\n{previous.get('description', '')}\n\n{body}"


async def generate(course: Course, description: str, previous: dict[str, Any] | None = None, feedback: str = "") -> dict[str, Any]:
    """Asks the model for a tool and returns it in the same shape the author's editors use (not saved)."""
    system = TOOL_GEN_SYSTEM.format(course=course.title, domain=DOMAINS.get(course.domain, course.domain))
    parts = [f"## Описание от автора\n{description.strip()}"]
    if previous:
        system += "\n\n" + TOOL_GEN_EDIT
        parts.append(_previous_block(previous))
        if feedback.strip():
            parts.append(f"## Что изменить или исправить\n{feedback.strip()}")
    raw = await get_llm().complete_json(system=system, prompt="\n\n".join(parts), schema=TOOL_GEN_SCHEMA, tier="smart")
    kind = raw.get("kind") if raw.get("kind") in KINDS else ("html" if str(raw.get("html", "")).strip() else "formula")
    try:
        spec, code = clean_tool(kind, {"inputs": raw.get("inputs"), "outputs": raw.get("outputs"), "notes": raw.get("notes"), "height": raw.get("height")}, str(raw.get("html", "")))
    except ValueError as e:
        raise ValueError(f"ИИ вернул неполный инструмент: {e}. Уточните описание или попробуйте ещё раз") from e
    return {
        "kind": kind, "name": _text(raw.get("name"), 80) or "Новый инструмент", "icon": _text(raw.get("icon"), 8) or "🧩",
        "description": _text(raw.get("description"), 600), "spec": spec, "code": code,
    }  # fmt: skip
