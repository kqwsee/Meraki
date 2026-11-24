"""Talent evidence and live talent scores.

The profile update (services/profile.py) gives the seven mind axes a smooth 0..1 estimate. This module
turns that estimate into something a learner can inspect: after every learner message an AI pass names
the axes the message really speaks to, quotes the exact words, explains the influence and nudges the
score. The evidence is stored with a link back to the message, and paste/delete revisions of the draft
are kept so the learner can see "what it was originally" and "what it became".

Analysis is deliberately incremental and debounced: a message becomes visible in the profile within a
couple of seconds, without re-reading the whole history on every keystroke.
"""

import asyncio
import logging
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..llm import get_llm
from ..models import Course, GraphNode, Message, TalentScore, TalentSignal, User, utcnow
from ..prompts import TALENT_ANALYSIS_SCHEMA, TALENT_ANALYSIS_SYSTEM, TALENT_AXES
from . import integrity
from .context import MIND_AXES

log = logging.getLogger("meraki.talents")

# Presentation metadata for the seven axes. `hint` is the neutral fallback until the AI has written
# a per-learner note; `title` is the human name of the talent.
TALENT_META: dict[str, dict[str, str]] = {
    "engineering": {
        "icon": "⚙️",
        "title": "Инженерный",
        "hint": "Устройства, механизмы, схемы и конструирование: как ученик разбирает систему на части и собирает её заново.",
    },
    "analytical": {
        "icon": "📐",
        "title": "Аналитико-математический",
        "hint": "Формальные рассуждения, вычисления, доказательства и поиск закономерностей.",
    },
    "it": {
        "icon": "💻",
        "title": "Алгоритмический",
        "hint": "Алгоритмы, код, структуры данных, отладка и декомпозиция задачи на шаги.",
    },
    "natural_science": {
        "icon": "🔬",
        "title": "Естественно-научный",
        "hint": "Физика, химия, биология, эксперимент и причинно-следственные связи.",
    },
    "humanities": {
        "icon": "📚",
        "title": "Гуманитарный",
        "hint": "Тексты, смыслы, история, аргументация и язык.",
    },
    "creative": {
        "icon": "🎨",
        "title": "Творческий",
        "hint": "Нестандартные идеи, метафоры, переносы и собственные примеры.",
    },
    "practical": {
        "icon": "🛠️",
        "title": "Прикладной",
        "hint": "Доводит до результата, пользуется инструментами и применяет знание к реальным задачам.",
    },
}

CLAMP_MIN, CLAMP_MAX = 0.02, 0.98
MAX_DELTA_POINTS = 8.0
RECENT_DAYS = 7

# per-user debounce queue: message ids, plus 0 for "scan unanalysed recent messages"
_queues: dict[int, set[int]] = {}
_tasks: dict[int, asyncio.Task] = {}


# ---------- scores ----------


def _seed_scores(db: Session, user: User) -> None:
    """Create the first history point for a learner who already had a profile before this feature."""
    if db.scalar(select(TalentScore.id).where(TalentScore.user_id == user.id).limit(1)) is not None:
        return
    for key in TALENT_AXES:
        db.add(TalentScore(user_id=user.id, talent=key, score=float((user.mind_profile or {}).get(key) or 0.0), source="initial"))
    db.commit()


def _score_history(db: Session, user_id: int) -> dict[str, list[TalentScore]]:
    rows = db.scalars(
        select(TalentScore)
        .where(TalentScore.user_id == user_id)
        .order_by(TalentScore.talent, TalentScore.created_at.desc(), TalentScore.id.desc())
    ).all()
    out: dict[str, list[TalentScore]] = {k: [] for k in TALENT_AXES}
    for row in rows:
        out.setdefault(row.talent, []).append(row)
    return out


def _score_pair(history: dict[str, list[TalentScore]], talent: str) -> tuple[float, float]:
    rows = history.get(talent) or []
    current = float(rows[0].score) if rows else 0.0
    previous = float(rows[1].score) if len(rows) > 1 else current
    return current, previous


def record_profile_scores(db: Session, user: User, old_scores: dict[str, Any]) -> None:
    """Called by update_profile after the AI recalculated mind_profile.

    Adds a history point per axis and, when an axis actually moved, a profile-level signal so the
    talent page can explain the jump between two full-profile recalculations.
    """
    now = utcnow()
    for key in TALENT_AXES:
        new = float((user.mind_profile or {}).get(key) or 0.0)
        old = float(old_scores.get(key) or new)
        db.add(TalentScore(user_id=user.id, talent=key, score=new, source="profile", created_at=now))
        delta = (new - old) * 100
        if abs(delta) >= 0.5:
            db.add(
                TalentSignal(
                    user_id=user.id,
                    talent=key,
                    kind="profile",
                    delta=round(delta, 1),
                    score_before=round(old, 4),
                    score_after=round(new, 4),
                    reason=(
                        "ИИ пересмотрел профиль целиком: показатель "
                        f"{'вырос' if delta > 0 else 'снизился'} с {round(old * 100)}% до {round(new * 100)}%. "
                        "Ниже — конкретные сообщения, на которые он опирался."
                    ),
                    created_at=now,
                )
            )


# ---------- analysis pipeline ----------


def schedule_analysis(user_id: int, message_ids: list[int] | None = None, *, scan_all: bool = False) -> None:
    """Queue an incremental analysis. Cheap to call on every message: calls within ~1.2 s are merged."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    queue = _queues.setdefault(user_id, set())
    if message_ids:
        queue.update(int(i) for i in message_ids if int(i) > 0)
    if scan_all or not message_ids:
        queue.add(0)
    running = _tasks.get(user_id)
    if running is not None and not running.done():
        return
    task = loop.create_task(_worker(user_id))
    _tasks[user_id] = task

    def _done(t: asyncio.Task) -> None:
        if _tasks.get(user_id) is t:
            _tasks.pop(user_id, None)

    task.add_done_callback(_done)


async def _worker(user_id: int) -> None:
    first = True
    try:
        while True:
            # debounce: give a fast writer a moment so several messages go in one AI call
            await asyncio.sleep(1.2 if first else 0.15)
            first = False
            ids = _queues.pop(user_id, None)
            if not ids:
                break
            scan_all = 0 in ids
            wanted = sorted(i for i in ids if i > 0)
            try:
                # a full scan already covers the specific ids; don't narrow it down and lose them
                if scan_all:
                    await analyze_messages(user_id, scan_all=True)
                else:
                    await analyze_messages(user_id, message_ids=wanted or None)
            except Exception:
                log.exception("talent analysis failed for user %s", user_id)
            if not _queues.get(user_id):
                break
    finally:
        _tasks.pop(user_id, None)


async def analyze_messages(
    user_id: int, *, message_ids: list[int] | None = None, scan_all: bool = False, limit: int = 10
) -> None:
    """Run one AI pass over learner messages and store the resulting evidence."""
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        stmt = select(Message).where(Message.user_id == user_id, Message.role == "user", Message.talent_analyzed.is_(False))
        if message_ids:
            stmt = stmt.where(Message.id.in_(message_ids))
        elif not scan_all:
            return
        # newest first, then restore chronological order for the prompt
        messages = list(db.scalars(stmt.order_by(Message.id.desc()).limit(limit)).all())
        messages.reverse()
        if not messages:
            return
        scores = {k: round(float((user.mind_profile or {}).get(k) or 0.0), 3) for k in TALENT_AXES}
        nodes = _nodes_for(db, {m.node_id for m in messages})
        prompt = _analysis_prompt(messages, nodes, scores)
        message_rows = [(m.id, m.node_id, m.stage, dict(m.meta or {}), m.content) for m in messages]

    try:
        result = await get_llm().complete_json(
            system=TALENT_ANALYSIS_SYSTEM, prompt=prompt, schema=TALENT_ANALYSIS_SCHEMA, tier="fast"
        )
    except Exception:
        log.exception("talent analysis LLM failed for user %s", user_id)
        return

    raw_signals = result.get("signals") if isinstance(result, dict) else None
    signals = raw_signals if isinstance(raw_signals, list) else []

    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        current = {k: round(float((user.mind_profile or {}).get(k) or 0.0), 3) for k in TALENT_AXES}
        by_index = {i + 1: row for i, row in enumerate(message_rows)}
        seen: set[tuple[int, str]] = set()
        for item in signals:
            if not isinstance(item, dict):
                continue
            try:
                index = int(item.get("message", 0))
            except (TypeError, ValueError):
                continue
            row = by_index.get(index)
            talent = str(item.get("talent", ""))
            if row is None or talent not in TALENT_AXES:
                continue
            msg_id = row[0]
            if (msg_id, talent) in seen:
                continue
            seen.add((msg_id, talent))
            try:
                delta = max(-MAX_DELTA_POINTS, min(MAX_DELTA_POINTS, float(item.get("delta", 0))))
            except (TypeError, ValueError):
                delta = 0.0
            if abs(delta) < 0.05:
                continue
            before = current[talent]
            after = round(max(CLAMP_MIN, min(CLAMP_MAX, before + delta / 100)), 4)
            if after == before:
                continue
            current[talent] = after
            meta = row[3]
            quote = _verified_quote(row[4], str(item.get("quote", "")).strip()[:1000])
            revision = _pick_revision(meta, quote)
            reason = str(item.get("reason", "")).strip()[:1200]
            db.add(
                TalentSignal(
                    user_id=user_id,
                    talent=talent,
                    message_id=msg_id,
                    node_id=row[1],
                    stage=row[2],
                    kind="message",
                    delta=round((after - before) * 100, 1),
                    score_before=before,
                    score_after=after,
                    reason=reason,
                    excerpt=quote,
                    before_text=str((revision or {}).get("before", ""))[:1500],
                    after_text=str((revision or {}).get("after", ""))[:1500],
                    revision_kind=str((revision or {}).get("kind", ""))[:20],
                )
            )
            db.add(
                TalentScore(
                    user_id=user_id,
                    talent=talent,
                    score=after,
                    source="message",
                    message_id=msg_id,
                )
            )
        mind = dict(user.mind_profile or {})
        mind.update({k: round(v, 4) for k, v in current.items()})
        user.mind_profile = mind
        # mark every analysed message, even if it produced no signal, so small talk is not re-read forever
        ids = [row[0] for row in message_rows]
        for m in db.scalars(select(Message).where(Message.id.in_(ids))).all():
            m.talent_analyzed = True
        db.commit()


def _analysis_prompt(messages: list[Message], nodes: dict[int, tuple[GraphNode, Course | None]], scores: dict[str, float]) -> str:
    lines = ["Текущие показатели (0–100):"]
    for key in TALENT_AXES:
        lines.append(f"- {key} ({TALENT_META[key]['title']}): {round(scores.get(key, 0.0) * 100)}")
    lines.append("\nСообщения ученика:")
    for i, m in enumerate(messages, 1):
        node, course = nodes.get(m.node_id, (None, None))
        where = f"«{node.title}»" if node else "без темы"
        if course:
            where += f" (курс «{course.title}»)"
        lines.append(f"\n### Сообщение {i}")
        lines.append(f"Место: {where}, этап: {m.stage}")
        typing = _typing_summary(m.meta or {})
        if typing:
            lines.append(f"Ввод: {typing}")
        lines.append("Текст:\n" + _clip(m.content, 1800))
    lines.append(
        "\nВерни сигналы только по сообщениям, где есть настоящее свидетельство. "
        "Помни: отрицательная delta — это тоже свидетельство, если ученик путается."
    )
    return "\n".join(lines)


def _typing_summary(meta: dict[str, Any]) -> str:
    typing = meta.get("typing") or {}
    if not isinstance(typing, dict):
        typing = {}
    parts: list[str] = []
    try:
        chars, ms = int(typing.get("chars") or 0), int(typing.get("ms") or 0)
        if chars:
            cpm = chars * 60000 / max(ms, 1)
            parts.append(f"{chars} знаков за {max(1, round(ms / 1000))} с (~{round(cpm)} зн/мин)")
    except (TypeError, ValueError):
        pass
    if int(typing.get("pauses_2s") or 0):
        parts.append(f"пауз ≥2 с: {int(typing['pauses_2s'])}")
    if int(typing.get("backspaces") or 0):
        parts.append(f"удалений: {int(typing['backspaces'])}")
    revisions = typing.get("revisions")
    if isinstance(revisions, list) and revisions:
        bits = []
        for rev in revisions[-3:]:
            if not isinstance(rev, dict):
                continue
            kind = {"paste": "вставка", "delete": "удаление", "drop": "перетаскивание", "insert": "вставка"}.get(
                str(rev.get("kind", "")), "правка"
            )
            before, after = _clip(str(rev.get("before", "")), 160), _clip(str(rev.get("after", "")), 160)
            bits.append(f"{kind}: было «{before}» → стало «{after}»")
        if bits:
            parts.append("черновик — " + "; ".join(bits))
    return ", ".join(parts)


def _verified_quote(content: str, quote: str) -> str:
    """Keep the model honest: the evidence block must be the learner's own words, never a paraphrase."""
    if quote and quote in content:
        return quote
    norm_content = " ".join(content.split())
    norm_quote = " ".join(quote.split())
    if norm_quote and norm_quote in norm_content:
        return norm_quote
    return _clip(content, 240)


def _pick_revision(meta: dict[str, Any], quote: str) -> dict[str, Any] | None:
    typing = meta.get("typing") or {}
    if not isinstance(typing, dict):
        return None
    revisions = typing.get("revisions")
    if not isinstance(revisions, list) or not revisions:
        return None
    clean = [r for r in revisions if isinstance(r, dict)]
    if not clean:
        return None
    if quote:
        # prefer the revision that left the quote in the final draft; a deletion only "contains" it
        # in the before-state, which is the fallback for evidence about removed text
        for rev in reversed(clean):
            if quote in str(rev.get("after", "")):
                return rev
        for rev in reversed(clean):
            if quote in str(rev.get("before", "")):
                return rev
    return clean[-1]


def _nodes_for(db: Session, node_ids: set[int | None]) -> dict[int, tuple[GraphNode, Course | None]]:
    ids = {i for i in node_ids if i is not None}
    if not ids:
        return {}
    out: dict[int, tuple[GraphNode, Course | None]] = {}
    courses: dict[int, Course | None] = {}
    for node in db.scalars(select(GraphNode).where(GraphNode.id.in_(ids))).all():
        if node.course_id not in courses:
            courses[node.course_id] = db.get(Course, node.course_id)
        out[node.id] = (node, courses[node.course_id])
    return out


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# ---------- read models ----------


def writing_evidence(db: Session, user: User, limit: int = 80) -> dict[str, Any]:
    """Concrete messages behind the "how you write and think" section.

    Unlike talent evidence this is deterministic: every learner message is listed with its typing
    metrics, the reading of that rhythm and the draft revisions (paste/delete). It updates as soon
    as the message is stored, without waiting for an AI pass.
    """
    messages = list(
        db.scalars(
            select(Message)
            .where(Message.user_id == user.id, Message.role == "user")
            .order_by(Message.id.desc())
            .limit(limit)
        ).all()
    )
    nodes = _nodes_for(db, {m.node_id for m in messages})
    baseline = float(user.typing_baseline.get("cpm") or 0)
    items = []
    for m in messages:
        node, course = nodes.get(m.node_id, (None, None))
        typing = (m.meta or {}).get("typing")
        if not isinstance(typing, dict):
            typing = {}
        chars, ms = _as_int(typing.get("chars")), _as_int(typing.get("ms"))
        pauses, backspaces = _as_int(typing.get("pauses_2s")), _as_int(typing.get("backspaces"))
        cpm = round(chars * 60000 / ms) if chars and ms else None
        raw_revisions = typing.get("revisions")
        revisions = [r for r in raw_revisions if isinstance(r, dict)] if isinstance(raw_revisions, list) else []
        items.append(
            {
                "id": m.id,
                "content": m.content[:4000],
                "created_at": m.created_at.isoformat(),
                "node_id": m.node_id,
                "node_title": node.title if node else "",
                "course_id": course.id if course else None,
                "course_title": course.title if course else "",
                "stage": m.stage,
                "metrics": {
                    "chars": chars,
                    "ms": ms,
                    "cpm": cpm,
                    "pauses_2s": pauses,
                    "backspaces": backspaces,
                    "iki_median": typing.get("iki_median"),
                    "iki_cv": typing.get("iki_cv"),
                    "sentence_pauses": _as_int(typing.get("sentence_pauses")),
                },
                "baseline_cpm": round(baseline) if baseline else None,
                "notes": _writing_notes(chars, pauses, backspaces, cpm, baseline, bool(revisions)),
                "revisions": _coalesce_revisions(revisions),
            }
        )
    return {
        "baseline_cpm": round(baseline) if baseline else None,
        "traits": integrity.describe_writing(user.writing_profile or {}),
        "writing_profile": user.writing_profile or {},
        "messages": items,
    }


def _coalesce_revisions(revisions: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Turn a run of per-character backspaces into one "was → became" edit."""
    out: list[dict[str, str]] = []
    for r in revisions:
        kind = str(r.get("kind", ""))[:20]
        before = str(r.get("before", ""))[:1500]
        after = str(r.get("after", ""))[:1500]
        if out and out[-1]["kind"] == kind and out[-1]["after"] == before:
            out[-1]["after"] = after
        else:
            out.append({"kind": kind, "before": before, "after": after})
    return out[-4:]


def _writing_notes(chars: int, pauses: int, backspaces: int, cpm: int | None, baseline: float, has_revisions: bool) -> list[str]:
    notes: list[str] = []
    if cpm:
        if baseline and cpm >= baseline * 1.3:
            notes.append(f"Быстрее своей обычной скорости: ~{cpm} зн/мин против ~{round(baseline)} зн/мин.")
        elif baseline and cpm <= baseline * 0.6:
            notes.append(
                f"Медленнее своей обычной скорости: ~{cpm} зн/мин против ~{round(baseline)} зн/мин — "
                "возможно, материал требует обдумывания."
            )
        else:
            notes.append(f"Обычный темп: ~{cpm} зн/мин.")
    if chars >= 20:
        if pauses == 0:
            notes.append("Ни одной паузы ≥2 с — мысль шла потоком.")
        elif pauses * 100 / chars >= 3:
            notes.append(f"{pauses} пауз ≥2 с на {chars} знаков — часто останавливается подумать.")
        if backspaces == 0:
            notes.append("Без правок по ходу.")
        elif backspaces * 100 / chars >= 8:
            notes.append(f"{backspaces} удалений на {chars} знаков — переформулирует по ходу письма.")
    if has_revisions:
        notes.append("В черновике были вставки или удаления — ниже видно, что было и что стало.")
    return notes


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def overview(db: Session, user: User) -> dict[str, Any]:
    _seed_scores(db, user)
    history = _score_history(db, user.id)
    counts = {
        talent: (int(n), last)
        for talent, n, last in db.execute(
            select(TalentSignal.talent, func.count(TalentSignal.id), func.max(TalentSignal.created_at))
            .where(TalentSignal.user_id == user.id)
            .group_by(TalentSignal.talent)
        ).all()
    }
    # two freshest observations per axis, so one busy talent cannot crowd out the others
    recent_rows: list[TalentSignal] = []
    for key in TALENT_AXES:
        recent_rows.extend(
            db.scalars(
                select(TalentSignal)
                .where(TalentSignal.user_id == user.id, TalentSignal.talent == key)
                .order_by(TalentSignal.created_at.desc(), TalentSignal.id.desc())
                .limit(2)
            ).all()
        )
    nodes = _nodes_for(db, {s.node_id for s in recent_rows})
    messages = _messages_for(db, {s.message_id for s in recent_rows})
    recent: dict[str, list[dict[str, Any]]] = {k: [] for k in TALENT_AXES}
    for signal in recent_rows:
        recent.setdefault(signal.talent, []).append(_signal_json(signal, nodes, messages))

    talents = []
    for key in TALENT_AXES:
        current, previous = _score_pair(history, key)
        n, last = counts.get(key, (0, None))
        talents.append(
            {
                "key": key,
                "label": MIND_AXES.get(key, key),
                "title": TALENT_META[key]["title"],
                "icon": TALENT_META[key]["icon"],
                "hint": TALENT_META[key]["hint"],
                "description": (user.talent_notes or {}).get(key) or TALENT_META[key]["hint"],
                "score": round(current, 4),
                "previous": round(previous, 4),
                "delta": round((current - previous) * 100, 1),
                "signals": n,
                "last_at": last.isoformat() if last else None,
                "recent": recent.get(key, []),
            }
        )
    since = utcnow() - timedelta(days=RECENT_DAYS)
    pending = db.scalar(
        select(func.count())
        .select_from(Message)
        .where(
            Message.user_id == user.id,
            Message.role == "user",
            Message.talent_analyzed.is_(False),
            Message.created_at >= since,
        )
    ) or 0
    return {
        "updated_at": user.profile_updated_at.isoformat() if user.profile_updated_at else None,
        "intro": user.talents,
        "pending": int(pending),
        # the in-process analyser is currently looking at this learner's messages
        "analyzing": user.id in _tasks or user.id in _queues,
        "talents": talents,
    }


def detail(db: Session, user: User, talent: str) -> dict[str, Any] | None:
    if talent not in TALENT_AXES:
        return None
    _seed_scores(db, user)
    history = _score_history(db, user.id)
    current, previous = _score_pair(history, talent)
    rows = list(
        db.scalars(
            select(TalentSignal)
            .where(TalentSignal.user_id == user.id, TalentSignal.talent == talent)
            .order_by(TalentSignal.created_at.desc(), TalentSignal.id.desc())
            .limit(100)
        ).all()
    )
    nodes = _nodes_for(db, {s.node_id for s in rows})
    messages = _messages_for(db, {s.message_id for s in rows})
    count = db.scalar(
        select(func.count(TalentSignal.id)).where(TalentSignal.user_id == user.id, TalentSignal.talent == talent)
    ) or 0
    last = db.scalar(
        select(func.max(TalentSignal.created_at)).where(TalentSignal.user_id == user.id, TalentSignal.talent == talent)
    )
    return {
        "talent": {
            "key": talent,
            "label": MIND_AXES.get(talent, talent),
            "title": TALENT_META[talent]["title"],
            "icon": TALENT_META[talent]["icon"],
            "hint": TALENT_META[talent]["hint"],
            "description": (user.talent_notes or {}).get(talent) or TALENT_META[talent]["hint"],
            "score": round(current, 4),
            "previous": round(previous, 4),
            "delta": round((current - previous) * 100, 1),
            "signals": int(count),
            "last_at": last.isoformat() if last else None,
        },
        "analyzing": user.id in _tasks or user.id in _queues,
        "signals": [_signal_json(s, nodes, messages) for s in rows],
    }


def _messages_for(db: Session, message_ids: set[int | None]) -> dict[int, Message]:
    ids = {i for i in message_ids if i is not None}
    if not ids:
        return {}
    return {m.id: m for m in db.scalars(select(Message).where(Message.id.in_(ids))).all()}


def _signal_json(
    signal: TalentSignal,
    nodes: dict[int, tuple[GraphNode, Course | None]],
    messages: dict[int, Message],
) -> dict[str, Any]:
    node, course = nodes.get(signal.node_id, (None, None)) if signal.node_id else (None, None)
    message = messages.get(signal.message_id) if signal.message_id is not None else None
    return {
        "id": signal.id,
        "kind": signal.kind,
        "talent": signal.talent,
        "message_id": signal.message_id,
        "node_id": signal.node_id,
        "node_title": node.title if node else "",
        "course_id": course.id if course else None,
        "course_title": course.title if course else "",
        "stage": signal.stage,
        "delta": round(signal.delta, 1),
        "score_before": round(signal.score_before, 4),
        "score_after": round(signal.score_after, 4),
        "reason": signal.reason,
        "excerpt": signal.excerpt,
        "message_content": (message.content[:4000] if message else ""),
        "message_created_at": message.created_at.isoformat() if message else None,
        "before_text": signal.before_text,
        "after_text": signal.after_text,
        "revision_kind": signal.revision_kind,
        "created_at": signal.created_at.isoformat(),
    }
