"""Passages of the course materials that the author pinned as mandatory.

A pinned `topic` is taught on the lecture almost as the author wrote it; a pinned `task` is given to
learners almost as written (the AI only adds what the author's text lacks: rubric, solution, hints, starter files).
"""

import re
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import GraphNode, PinnedExcerpt, Task

KINDS = ("topic", "task")
USE_IN = ("practice", "exam")

MAX_TOPIC_CHARS = 30_000  # one pinned topic passage
MAX_TASK_CHARS = 6_000  # one pinned task
THEORY_BUDGET = 20_000  # all pinned topic text of one node that goes into a lecture prompt
OUTLINE_CHARS = 500  # per passage, when only a reminder of the author's topics is needed
MIN_COVERAGE = 0.7  # share of the author's words that must survive in a generated task statement

LIMITS = {"topic_chars": MAX_TOPIC_CHARS, "task_chars": MAX_TASK_CHARS, "theory_budget": THEORY_BUDGET}


def excerpt_json(e: PinnedExcerpt) -> dict[str, Any]:
    return {
        "id": e.id, "node_id": e.node_id, "material_id": e.material_id, "source": e.source, "kind": e.kind,
        "use_in": e.use_in, "title": e.title, "content": e.content, "char_start": e.char_start, "char_end": e.char_end,
        "position": e.position,
    }  # fmt: skip


def auto_title(content: str) -> str:
    first = next((ln.strip(" #*-–—\t") for ln in content.splitlines() if ln.strip(" #*-–—\t")), "")
    return (first[:57] + "…") if len(first) > 60 else first or "Фрагмент"


def node_excerpts(db: Session, node_id: int, kind: str, use_in: str | None = None) -> list[PinnedExcerpt]:
    stmt = select(PinnedExcerpt).where(PinnedExcerpt.node_id == node_id, PinnedExcerpt.kind == kind)
    if use_in:
        stmt = stmt.where(PinnedExcerpt.use_in == use_in)
    return list(db.scalars(stmt.order_by(PinnedExcerpt.position, PinnedExcerpt.id)).all())


# ---------- topics: lecture, prologue, task generation ----------


def theory_block(db: Session, node: GraphNode) -> str:
    """The author's mandatory topics in full, for the lecture prompt (up to THEORY_BUDGET characters)."""
    items = node_excerpts(db, node.id, "topic")
    if not items:
        return ""
    total = sum(len(e.content) for e in items)
    share = 1.0 if total <= THEORY_BUDGET else THEORY_BUDGET / total
    parts = []
    for i, e in enumerate(items, start=1):
        text = e.content if share == 1.0 else e.content[: max(400, int(len(e.content) * share))] + "\n[…фрагмент сокращён]"
        parts.append(f"### {i}. {e.title}" + (f" (источник: {e.source})" if e.source else "") + f"\n{text}")
    return "## Обязательные темы преподавателя\n" + "\n\n".join(parts)


def theory_outline(db: Session, node: GraphNode, with_text: bool = False) -> str:
    """Titles of the author's mandatory topics (with a short start of each when `with_text`)."""
    items = node_excerpts(db, node.id, "topic")
    if not items:
        return ""
    if not with_text:
        return "; ".join(f"«{e.title}»" for e in items)
    return "\n".join(f"- «{e.title}»: {' '.join(e.content[:OUTLINE_CHARS].split())}" for e in items)


# ---------- tasks: practice and exam generation ----------


def mandatory_tasks(db: Session, user_id: int, node_id: int, use_in: str) -> list[PinnedExcerpt]:
    """Pinned tasks still to be given to this learner. Practice gives each one once;
    every exam attempt gets all of its own, since an attempt is a fresh set."""
    items = node_excerpts(db, node_id, "task", use_in)
    if use_in == "exam":
        return items
    given = set(db.scalars(select(Task.excerpt_id).where(Task.user_id == user_id, Task.node_id == node_id, Task.excerpt_id.is_not(None))).all())
    return [e for e in items if e.id not in given]


def mandatory_tasks_block(items: list[PinnedExcerpt]) -> str:
    if not items:
        return ""
    parts = [f"### excerpt_id={e.id} · «{e.title}»" + (f" (источник: {e.source})" if e.source else "") + f"\n{e.content}" for e in items]
    return "## Обязательные задания (от преподавателя)\n" + "\n\n".join(parts)


def _words(text: str) -> Counter[str]:
    return Counter(re.findall(r"\w+", text.lower()))


def coverage(original: str, generated: str) -> float:
    """Share of the original's words that are still in the generated text (formatting-proof, order-blind)."""
    want = _words(original)
    if not want:
        return 1.0
    have = _words(generated)
    return sum(min(n, have[w]) for w, n in want.items()) / sum(want.values())


def tidy(content: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", content)).strip()


def _fallback_task(e: PinnedExcerpt) -> dict[str, Any]:
    """Used when the model left a pinned task out: the author's text goes in as is, graded by its meaning."""
    return {
        "title": e.title, "statement": tidy(e.content), "kind": "text", "language": "", "concept": e.title[:200], "bloom": "apply",
        "scaffold": "make", "starter_files": [], "hints": [], "solution": "",
        "rubric": "Задание от преподавателя: оцени полноту и правильность решения по условию и ход рассуждений.",
        "excerpt_id": e.id,
    }  # fmt: skip


def merge_mandatory(tasks: list[dict[str, Any]], mandatory: list[PinnedExcerpt], total: int) -> list[dict[str, Any]]:
    """Makes sure every pinned task is given and its statement stayed close to the author's text.

    `tasks` is the model's answer. A pinned task the model dropped is added as is; one it rewrote too freely
    gets the author's text back as the statement (the model's rubric, solution and hints are kept).
    Of the model's own tasks only as many are kept as fit the total (plus one spare, as before)."""
    by_id = {e.id: e for e in mandatory}
    own_room = max(1, total - len(mandatory) + 1)
    used: set[int] = set()
    result: list[dict[str, Any]] = []
    for t in tasks:  # the model's order is kept: it follows the ladder of scaffolds
        try:
            eid = int(t.get("excerpt_id") or 0)
        except (TypeError, ValueError):
            eid = 0
        e = by_id.get(eid)
        if e is None or eid in used:
            if own_room > 0:
                own_room -= 1
                t["excerpt_id"] = None
                result.append(t)
            continue
        used.add(eid)
        t["excerpt_id"] = eid
        if coverage(e.content, str(t.get("statement", ""))) < MIN_COVERAGE:
            t["statement"] = tidy(e.content)
        result.append(t)
    return result + [_fallback_task(e) for e in mandatory if e.id not in used]
