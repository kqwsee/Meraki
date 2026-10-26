import logging
import re

from sqlalchemy import delete, update

from ..db import SessionLocal
from ..llm import get_llm
from ..models import Course, GraphEdge, GraphNode, LearnerPath, NodeProgress, PinnedExcerpt
from ..prompts import COURSE_GRAPH_SCHEMA, COURSE_GRAPH_SYSTEM, DOMAINS, TOOL_CATALOG
from . import materials

log = logging.getLogger("meraki.course")

DEFAULT_TOOLS = {
    "it": ["python", "javascript", "sql", "regex", "json", "numbase"],
    "engineering": ["circuit", "plotter", "units", "calculator"],
    "physics": ["plotter", "units", "calculator", "circuit"],
    "math": ["plotter", "matrix", "calculator"],
    "biology": ["dna", "punnett", "calculator"],
    "chemistry": ["molar", "periodic", "calculator", "units"],
    "humanities": ["textstats", "notes"],
    "general": ["calculator", "notes"],
}


def _slug(value: str, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")
    return s[:60] or fallback


def _break_cycles(keys: list[str], requires: dict[str, list[str]]) -> dict[str, list[str]]:
    """Keep only edges consistent with a DFS topological order."""
    state: dict[str, int] = {}
    clean: dict[str, list[str]] = {k: [] for k in keys}

    def visit(k: str) -> None:
        state[k] = 1
        for r in requires.get(k, []):
            if state.get(r) == 1:  # back edge -> cycle, drop it
                continue
            if state.get(r) is None:
                visit(r)
            clean[k].append(r)
        state[k] = 2

    for k in keys:
        if state.get(k) is None:
            visit(k)
    return clean


async def build_course_graph(course_id: int) -> None:
    with SessionLocal() as db:
        course = db.get(Course, course_id)
        if course is None:
            return
        course.status, course.status_detail = "processing", "ИИ строит граф знаний…"
        db.commit()
        digest = materials.course_digest(db, course_id)
        prompt = (
            f"Курс: «{course.title}»\nОбласть: {DOMAINS.get(course.domain, course.domain)}\n"
            f"Описание от автора:\n{course.description or '—'}\n\n"
            f"Каталог инструментов (id: название):\n" + "\n".join(f"{k}: {v}" for k, v in TOOL_CATALOG.items()) +
            f"\n\nМатериалы курса:\n{digest or '(материалы не загружены — опирайся на описание и общие знания предмета)'}"
        )  # fmt: skip
    try:
        result = await get_llm().complete_json(system=COURSE_GRAPH_SYSTEM, prompt=prompt, schema=COURSE_GRAPH_SCHEMA, tier="smart")
    except Exception as e:
        log.exception("graph build failed")
        with SessionLocal() as db:
            course = db.get(Course, course_id)
            if course:
                course.status, course.status_detail = "error", f"Не удалось построить граф: {e}"
                db.commit()
        return

    raw_nodes = result.get("nodes") or []
    with SessionLocal() as db:
        course = db.get(Course, course_id)
        if course is None:
            return
        node_ids = [n.id for n in course.nodes]
        if node_ids:
            db.execute(delete(NodeProgress).where(NodeProgress.node_id.in_(node_ids)))
        db.execute(delete(GraphEdge).where(GraphEdge.course_id == course_id))
        db.execute(delete(LearnerPath).where(LearnerPath.course_id == course_id))
        # the author's pinned passages outlive the topics: they wait to be attached to the new ones
        db.execute(update(PinnedExcerpt).where(PinnedExcerpt.course_id == course_id).values(node_id=None))
        db.execute(delete(GraphNode).where(GraphNode.course_id == course_id))

        keys: list[str] = []
        requires: dict[str, list[str]] = {}
        nodes: dict[str, GraphNode] = {}
        for i, raw in enumerate(raw_nodes):
            key = _slug(str(raw.get("key", "")), f"topic_{i + 1}")
            while key in nodes:
                key += "_x"
            node = GraphNode(
                course_id=course_id,
                key=key,
                title=str(raw.get("title", key))[:200],
                summary=str(raw.get("summary", "")),
                objectives=[str(x) for x in raw.get("objectives", [])][:6],
                concepts=[str(x) for x in raw.get("concepts", [])][:8],
                order_index=i,
            )
            db.add(node)
            nodes[key] = node
            keys.append(key)
            requires[key] = [_slug(str(r), "") for r in raw.get("requires", [])]
        db.flush()
        requires = {k: [r for r in v if r in nodes and r != k] for k, v in requires.items()}
        for key, reqs in _break_cycles(keys, requires).items():
            for r in dict.fromkeys(reqs):
                db.add(GraphEdge(course_id=course_id, src_id=nodes[r].id, dst_id=nodes[key].id))

        tools = [t for t in result.get("recommended_tools", []) if t in TOOL_CATALOG]
        course.tools = list(dict.fromkeys(DEFAULT_TOOLS.get(course.domain, []) + tools))
        course.summary = str(result.get("course_summary", ""))
        if nodes:
            course.status, course.status_detail = "ready", f"Граф построен: {len(nodes)} тем"
        else:
            course.status, course.status_detail = "error", "ИИ не предложил ни одной темы — добавьте материалы или описание"
        db.commit()
