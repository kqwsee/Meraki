"""Visual material for lectures: drafted by the AI in the course editor, checked by the author, shown by the tutor.

Kinds (rendered by frontend/src/visuals):
- mermaid: code = Mermaid source;
- svg: code = one <svg> element, shown as an image (scripts never run);
- chart: data = {type: bar|line|pie, labels, series: [{name, values}], x_label, y_label, unit};
- scheme: data = {template: flow|cycle|timeline|compare|hierarchy, items: [...]};
- html: code = a page for the sandboxed iframe, data = {height};
- tool: data = {tool_id, state}: a built-in tool opened with a ready example;
- image: asset_id = the author's picture; the author writes its description.

Only `approved` visuals reach learners and the tutor: the lecture never shows anything the author has not checked.
"""

import asyncio
import json
import logging
import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..background import spawn
from ..config import settings
from ..db import SessionLocal
from ..llm import get_llm
from ..models import Course, CourseAsset, GraphNode, TopicVisual
from ..prompts import DOMAINS, TOOL_CATALOG, TOOL_PRESET_DOCS, VISUAL_REDO, VISUAL_REDO_SCHEMA, VISUALS_GEN_SCHEMA, VISUALS_GEN_SYSTEM
from . import assets, custom_tools, materials, pins

log = logging.getLogger("meraki.visuals")

KINDS = ("mermaid", "svg", "chart", "scheme", "html", "tool", "image")
AI_KINDS = KINDS[:-1]
KIND_NAMES = {
    "mermaid": "схема", "svg": "рисунок", "chart": "диаграмма", "scheme": "схема", "html": "интерактив", "tool": "инструмент",
    "image": "картинка",
}  # fmt: skip
STATUSES = ("draft", "approved")
MAX_PER_NODE = 40
GEN_MIN, GEN_MAX = 3, 6

MAX_MERMAID = 8_000
MAX_SVG = 80_000
MAX_TOOL_STATE = 16_000
CHART_TYPES = ("bar", "line", "pie")
TEMPLATES = ("flow", "cycle", "timeline", "compare", "hierarchy")
TEMPLATE_COUNTS = {"flow": (2, 10), "cycle": (3, 8), "timeline": (2, 14), "compare": (2, 4), "hierarchy": (1, 8)}
MERMAID_TYPES = {
    "graph", "flowchart", "sequencediagram", "classdiagram", "statediagram", "statediagram-v2", "erdiagram", "journey", "gantt",
    "pie", "mindmap", "timeline", "quadrantchart", "xychart-beta", "xychart", "block-beta", "sankey-beta", "gitgraph",
    "requirementdiagram", "c4context", "architecture-beta", "packet-beta", "kanban", "radar-beta", "treemap-beta",
}  # fmt: skip
# state keys a visual may preset in a built-in tool, and their types (frontend/src/tools/*: useToolState)
TOOL_STATE_KEYS: dict[str, dict[str, type]] = {
    "python": {"code": str}, "javascript": {"code": str}, "sql": {"code": str},
    "regex": {"pattern": str, "flags": str, "text": str}, "json": {"text": str}, "numbase": {"value": str, "base": int},
    "plotter": {"fns": str, "range": dict}, "matrix": {"a": str, "b": str, "expr": str}, "dna": {"seq": str},
    "punnett": {"p1": str, "p2": str}, "molar": {"formula": str}, "textstats": {"text": str},
}  # fmt: skip


def _text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and abs(n) != float("inf") else None


def _unfence(code: str) -> str:
    code = (code or "").strip()
    m = re.match(r"^```[\w-]*[ \t]*\n(.*?)\n?```\s*$", code, re.S)
    return m.group(1).strip() if m else code


# ---------- validation ----------


def _clean_mermaid(code: str) -> str:
    code = _unfence(code)
    if len(code) > MAX_MERMAID:
        raise ValueError(f"Схема слишком большая ({len(code)} знаков, максимум {MAX_MERMAID})")
    body = re.sub(r"^---\n.*?\n---\n", "", code, flags=re.S)  # front matter (title, config)
    first = next((ln.strip() for ln in body.splitlines() if ln.strip() and not ln.strip().startswith("%%")), "")
    if not first or first.split()[0].lower().rstrip(":") not in MERMAID_TYPES:
        raise ValueError("Это не похоже на код Mermaid: первая строка должна называть тип схемы (flowchart TD, sequenceDiagram, mindmap…)")
    return code


def _clean_svg(code: str) -> str:
    code = _unfence(code)
    start, end = code.find("<svg"), code.rfind("</svg>")
    if start < 0 or end < start:
        raise ValueError("Нужен один элемент <svg>…</svg>")
    svg = code[start : end + 6]
    if len(svg) > MAX_SVG:
        raise ValueError(f"Рисунок слишком большой ({len(svg)} знаков, максимум {MAX_SVG})")
    # shown as an <img>, so nothing here can run anyway; these just keep the source clean
    svg = re.sub(r"<script\b.*?</script\s*>|<script\b[^>]*/>|<foreignObject\b.*?</foreignObject\s*>", "", svg, flags=re.S | re.I)
    svg = re.sub(r"\s on[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*')", "", svg, flags=re.I)
    root = re.match(r"<svg\b[^>]*>", svg, re.S)
    assert root is not None
    tag = root.group(0)
    new = tag
    if "xmlns=" not in tag:
        new = new.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    if "viewbox" not in tag.lower():
        w = re.search(r'\bwidth\s*=\s*"(\d+(?:\.\d+)?)(?:px)?"', tag)
        h = re.search(r'\bheight\s*=\s*"(\d+(?:\.\d+)?)(?:px)?"', tag)
        if w and h:
            new = new.replace("<svg", f'<svg viewBox="0 0 {w.group(1)} {h.group(1)}"', 1)
    return new + svg[len(tag) :]


def _clean_chart(data: dict[str, Any]) -> dict[str, Any]:
    kind = data.get("type")
    if kind not in CHART_TYPES:
        raise ValueError("Тип диаграммы: bar, line или pie")
    labels = [_text(x, 40) for x in (data.get("labels") or [])][:40]
    if len(labels) < 2:
        raise ValueError("В диаграмме нужно хотя бы две подписи (labels)")
    series = []
    for raw in (data.get("series") or [])[: 1 if kind == "pie" else 6]:
        if not isinstance(raw, dict):
            continue
        values = [_number(v) for v in (raw.get("values") or [])][: len(labels)]
        values += [None] * (len(labels) - len(values))
        if sum(v is not None for v in values) < 2:
            continue
        if kind == "pie" and any(v is not None and v < 0 for v in values):
            raise ValueError("В круговой диаграмме значения не могут быть отрицательными")
        series.append({"name": _text(raw.get("name"), 60), "values": values})
    if not series:
        raise ValueError("В диаграмме нет данных: series[].values должны быть числами")
    return {
        "type": kind, "labels": labels, "series": series, "x_label": _text(data.get("x_label"), 60),
        "y_label": _text(data.get("y_label"), 60), "unit": _text(data.get("unit"), 20),
    }  # fmt: skip


def _clean_items(raw: Any, template: str, depth: int, budget: list[int]) -> list[dict[str, Any]]:
    items = []
    for it in raw if isinstance(raw, list) else []:
        if not isinstance(it, dict) or budget[0] <= 0:
            continue
        title = _text(it.get("title"), 80)
        if not title:
            continue
        budget[0] -= 1
        item: dict[str, Any] = {"title": title, "text": _text(it.get("text"), 300)}
        if template == "timeline":
            item["when"] = _text(it.get("when"), 40)
        if template == "compare":
            item["points"] = [_text(p, 160) for p in (it.get("points") or []) if _text(p, 160)][:8]
        if template == "hierarchy" and depth < 4:
            item["children"] = _clean_items(it.get("children"), template, depth + 1, budget)
        items.append(item)
    return items


def _clean_scheme(data: dict[str, Any]) -> dict[str, Any]:
    template = data.get("template")
    if template not in TEMPLATES:
        raise ValueError("Шаблон схемы: flow, cycle, timeline, compare или hierarchy")
    items = _clean_items(data.get("items"), template, 1, [40])
    low, high = TEMPLATE_COUNTS[template]
    if len(items) < low:
        raise ValueError(f"В схеме «{template}» нужно хотя бы {low} элемента")
    return {"template": template, "items": items[:high]}


def _clean_tool(data: dict[str, Any]) -> dict[str, Any]:
    tool_id = data.get("tool_id")
    if tool_id not in TOOL_CATALOG:
        raise ValueError("Неизвестный инструмент")
    keys = TOOL_STATE_KEYS.get(tool_id, {})
    state: dict[str, Any] = {}
    for key, value in (data.get("state") or {}).items() if isinstance(data.get("state"), dict) else []:
        want = keys.get(key)
        if want is str and isinstance(value, (str, int, float)) and not isinstance(value, bool):
            state[key] = str(value)
        elif want is int and _number(value) is not None:
            state[key] = int(_number(value) or 0)
        elif want is dict and isinstance(value, dict):
            state[key] = {k: v for k, v in value.items() if _number(v) is not None}
    if tool_id == "plotter" and "range" in state:
        x0, x1 = _number(state["range"].get("x0")), _number(state["range"].get("x1"))
        state["range"] = {"x0": x0 if x0 is not None else -10, "x1": x1 if x1 is not None and x1 != x0 else (x0 or 0) + 20}
    if len(json.dumps(state, ensure_ascii=False)) > MAX_TOOL_STATE:
        raise ValueError("Пример для инструмента слишком большой")
    return {"tool_id": tool_id, "state": state}


def clean(kind: str, code: str, data: dict[str, Any] | None) -> tuple[str, dict[str, Any]]:
    """Validated (code, data) for a visual of this kind; raises ValueError with a message for the author."""
    data = data if isinstance(data, dict) else {}
    if kind == "mermaid":
        return _clean_mermaid(code), {}
    if kind == "svg":
        return _clean_svg(code), {}
    if kind == "chart":
        return "", _clean_chart(data)
    if kind == "scheme":
        return "", _clean_scheme(data)
    if kind == "html":
        spec, page = custom_tools.clean_tool("html", {"height": data.get("height")}, code)
        return page, spec
    if kind == "tool":
        return "", _clean_tool(data)
    if kind == "image":
        return "", {}
    raise ValueError("Неизвестный вид наглядного материала")


# ---------- reading ----------


def visual_json(v: TopicVisual, asset: CourseAsset | None = None) -> dict[str, Any]:
    return {
        "id": v.id, "node_id": v.node_id, "kind": v.kind, "title": v.title, "description": v.description, "code": v.code,
        "data": v.data, "status": v.status, "origin": v.origin, "position": v.position, "asset_id": v.asset_id,
        "asset": assets.asset_json(asset) if asset is not None else None,
    }  # fmt: skip


def with_assets(db: Session, rows: list[TopicVisual]) -> list[dict[str, Any]]:
    ids = {v.asset_id for v in rows if v.asset_id}
    by_id = {a.id: a for a in db.scalars(select(CourseAsset).where(CourseAsset.id.in_(ids))).all()} if ids else {}
    return [visual_json(v, by_id.get(v.asset_id) if v.asset_id else None) for v in rows]


def course_visuals(db: Session, course_id: int) -> list[TopicVisual]:
    return list(db.scalars(select(TopicVisual).where(TopicVisual.course_id == course_id).order_by(TopicVisual.position, TopicVisual.id)).all())


def node_visuals(db: Session, node_id: int, approved_only: bool = False) -> list[TopicVisual]:
    stmt = select(TopicVisual).where(TopicVisual.node_id == node_id)
    if approved_only:
        stmt = stmt.where(TopicVisual.status == "approved")
    return list(db.scalars(stmt.order_by(TopicVisual.position, TopicVisual.id)).all())


def approvable(v: TopicVisual) -> str | None:
    """Why this visual cannot be shown to learners yet, or None."""
    if v.kind == "image" and not v.asset_id:
        return "У картинки нет файла"
    if v.kind == "image" and len(v.description.strip()) < 10:
        return "Опишите, что на картинке и когда её показать: наставник видит только ваше описание"
    return None


def lecture_block(db: Session, node: GraphNode) -> str:
    """The approved visuals of a topic, as the tutor sees them in the lecture prompt."""
    items = node_visuals(db, node.id, approved_only=True)
    if not items:
        return ""
    lines = [f"- [[visual:{v.id}]] — {KIND_NAMES.get(v.kind, v.kind)} «{v.title}»: {v.description or '—'}" for v in items]
    return "## Наглядные материалы темы (проверены автором курса)\n" + "\n".join(lines)


def next_position(db: Session, node_id: int | None) -> int:
    last = db.scalar(select(func.max(TopicVisual.position)).where(TopicVisual.node_id == node_id))
    return (last + 1) if last is not None else 0


# ---------- AI drafts ----------


def _tools_doc(course: Course) -> str:
    ids = [t for t in dict.fromkeys([*course.tools, "plotter"]) if t in TOOL_PRESET_DOCS]
    return "\n".join(f"  {t} ({TOOL_CATALOG[t]}): {TOOL_PRESET_DOCS[t]}" for t in ids) or "  (подходящих инструментов нет — tool не используй)"


def _context(db: Session, course: Course, node: GraphNode) -> tuple[str, str]:
    system = VISUALS_GEN_SYSTEM.format(
        course=course.title, domain=DOMAINS.get(course.domain, course.domain), title=node.title, min_n=GEN_MIN, max_n=GEN_MAX,
        tools=_tools_doc(course),
    )  # fmt: skip
    theory = pins.theory_outline(db, node, with_text=True)
    found = materials.search(db, course.id, f"{node.title} {' '.join(node.concepts)}", limit=4)
    existing = node_visuals(db, node.id)
    parts = [
        f"## Курс\n«{course.title}». {course.summary or course.description or ''}".strip(),
        f"## Тема «{node.title}»\n{node.summary}\nЦели: {'; '.join(node.objectives) or '—'}\nПонятия: {', '.join(node.concepts) or '—'}",
        f"## Обязательные темы автора\n{theory}" if theory else "",
        "## Выдержки из материалов курса\n" + "\n\n---\n\n".join(found) if found else "",
        "## Уже есть (не повторяй)\n" + "\n".join(f"- {KIND_NAMES.get(v.kind, v.kind)} «{v.title}»: {v.description}" for v in existing) if existing else "",
    ]
    return system, "\n\n".join(p for p in parts if p)


def _accept(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """(clean fields, "") for a usable draft from the model, or (None, why it was dropped)."""
    if not isinstance(raw, dict) or raw.get("kind") not in AI_KINDS:
        return None, "неизвестный вид"
    try:
        code, data = clean(raw["kind"], str(raw.get("code") or ""), raw.get("data"))
    except ValueError as e:
        return None, str(e)
    return {
        "kind": raw["kind"], "title": _text(raw.get("title"), 200) or "Без названия",
        "description": str(raw.get("description") or "").strip()[:2000], "code": code, "data": data,
    }, ""  # fmt: skip


async def generate_for_node(node_id: int, wishes: str = "") -> list[int]:
    """Drafts visuals for one topic and stores them unapproved. Returns the new ids."""
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        course = db.get(Course, node.course_id) if node else None
        if node is None or course is None:
            raise ValueError("Тема не найдена")
        system, prompt = _context(db, course, node)
    if wishes.strip():
        prompt += f"\n\n## Пожелания автора курса\n{wishes.strip()}"
    result = await get_llm().complete_json(system=system, prompt=prompt, schema=VISUALS_GEN_SCHEMA, tier="smart")
    accepted, dropped = [], []
    for raw in (result.get("visuals") or [])[: GEN_MAX + 2]:
        item, why = _accept(raw)
        if item:
            accepted.append(item)
        else:
            dropped.append(why)
    if dropped:
        log.info("node %s: dropped %d drafts: %s", node_id, len(dropped), "; ".join(dropped))
    if not accepted:
        raise ValueError("ИИ не предложил ни одного годного материала" + (f" ({dropped[0]})" if dropped else "") + ". Попробуйте ещё раз или уточните пожелания")
    with SessionLocal() as db:
        node = db.get(GraphNode, node_id)
        if node is None:
            return []
        room = MAX_PER_NODE - len(node_visuals(db, node_id))
        position = next_position(db, node_id)
        created = []
        for item in accepted[: max(0, room)]:
            v = TopicVisual(course_id=node.course_id, node_id=node_id, status="draft", origin="ai", position=position, **item)
            position += 1
            db.add(v)
            created.append(v)
        # the latest drafting decides: an empty list clears suggestions that no longer fit
        node.image_queries = [_text(q, 120) for q in (result.get("image_queries") or []) if _text(q, 120)][:2]
        db.commit()
        return [v.id for v in created]


async def regenerate(v: TopicVisual, feedback: str) -> dict[str, Any]:
    """A new version of one visual from the author's remarks (not saved here)."""
    with SessionLocal() as db:
        node = db.get(GraphNode, v.node_id) if v.node_id else None
        course = db.get(Course, v.course_id)
        assert course is not None
        if node is None:
            raise ValueError("Сначала привяжите материал к теме")
        system, prompt = _context(db, course, node)
    current = {"kind": v.kind, "title": v.title, "description": v.description, "code": v.code, "data": v.data}
    prompt += (
        f"\n\n## Материал, который нужно переделать\n{json.dumps(current, ensure_ascii=False, indent=1)}"
        f"\n\n## Замечания автора\n{feedback.strip() or 'Сделай лучше: нагляднее и точнее.'}"
    )
    raw = await get_llm().complete_json(system=system + "\n\n" + VISUAL_REDO, prompt=prompt, schema=VISUAL_REDO_SCHEMA, tier="smart")
    item, why = _accept(raw)
    if item is None:
        raise ValueError(f"ИИ вернул негодный материал: {why}. Попробуйте ещё раз или уточните замечание")
    return item


# ---------- "prepare all topics" job ----------

_jobs: dict[int, dict[str, Any]] = {}  # course id -> progress of the bulk generation


def job_state(course_id: int) -> dict[str, Any] | None:
    return _jobs.get(course_id)


def start_bulk(course_id: int, node_ids: list[int]) -> dict[str, Any]:
    if (_jobs.get(course_id) or {}).get("running"):
        raise ValueError("Наглядность уже готовится")
    job = {"running": True, "total": len(node_ids), "done": 0, "failed": 0, "errors": [], "current": []}
    _jobs[course_id] = job
    spawn(_bulk(course_id, node_ids, job))
    return job


async def _bulk(course_id: int, node_ids: list[int], job: dict[str, Any]) -> None:
    gate = asyncio.Semaphore(max(1, settings.llm_max_concurrency))

    async def one(node_id: int) -> None:
        async with gate:
            with SessionLocal() as db:
                node = db.get(GraphNode, node_id)
                title = node.title if node else str(node_id)
            job["current"].append(title)
            try:
                await generate_for_node(node_id)
                job["done"] += 1
            except Exception as e:  # noqa: BLE001 - one topic failing must not stop the others
                log.warning("visuals for node %s failed: %s", node_id, e)
                job["failed"] += 1
                job["errors"].append(f"«{title}»: {e}"[:300])
            finally:
                job["current"].remove(title)

    try:
        await asyncio.gather(*(one(n) for n in node_ids))
    finally:
        job["running"] = False
