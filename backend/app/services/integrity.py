"""Telemetry ingestion and self-reliance heuristics.

The frontend batches events (see frontend/src/telemetry). Flags are raised only in practice and exam:
  paste        — clipboard insert of >= PASTE_FLAG_CHARS characters
  bulk_insert  — large non-typed insert (drag-and-drop etc.)
  burst        — a typing run much faster than the learner's own baseline speed
  tab_away     — exam window lost focus for a while
Practice flags are never punished: they steer the exam towards the same concepts.
Exam flags with a text fragment produce follow-up questions after the exam.
"""

from collections import Counter
from datetime import timedelta
from statistics import mean, median
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Event, IntegrityFlag, Task, User, utcnow

FLAG_STAGES = {"practice", "exam"}


def _cpm(chars: int, ms: int) -> float:
    return chars * 60000.0 / max(ms, 1)


def burst_threshold(user: User) -> float:
    base = float(user.typing_baseline.get("cpm") or 0)
    return max(settings.burst_cpm_floor, base * settings.burst_baseline_factor)


def _update_baseline(user: User, samples: list[float]) -> None:
    if not samples:
        return
    data = dict(user.typing_baseline or {})
    history = (list(data.get("samples", [])) + [round(s, 1) for s in samples])[-40:]
    data["samples"] = history
    data["cpm"] = round(median(history), 1)
    user.typing_baseline = data


def ingest(
    db: Session,
    user: User,
    *,
    session_id: str,
    node_id: int | None,
    stage: str,
    task_id: int | None,
    attempt_id: int | None,
    events: list[dict[str, Any]],
) -> int:
    flags = 0
    baseline_samples: list[float] = []
    threshold = burst_threshold(user)
    recent_away = False
    for raw in events[:500]:
        etype = str(raw.get("type", ""))[:40]
        data = raw.get("data") or {}
        target = str(raw.get("target", ""))[:300]
        ev_task = raw.get("task_id", task_id)
        db.add(Event(user_id=user.id, session_id=session_id, node_id=node_id, stage=stage, task_id=ev_task, type=etype, target=target, data=data))

        if etype == "visibility" and not data.get("hidden"):
            recent_away = int(data.get("away_ms") or 0) >= 3000

        chars = int(data.get("chars") or 0)
        if etype == "type_segment" and chars >= 20:
            cpm = _cpm(chars, int(data.get("ms") or 0))
            if cpm < threshold:
                baseline_samples.append(cpm)

        if stage not in FLAG_STAGES:
            continue

        flag: IntegrityFlag | None = None
        source = str(data.get("source", ""))
        if etype == "paste" and source == "internal:workspace":
            continue  # moving the learner's own text around is not a signal
        if etype == "paste" and chars >= settings.paste_flag_chars:
            sev = min(1.0, 0.5 + chars / 1500 + (0.2 if recent_away else 0))
            flag = IntegrityFlag(kind="paste", severity=sev, fragment=str(data.get("text", ""))[:2000],
                                 detail={"chars": chars, "after_tab_away": recent_away, "source": source or "external"})  # fmt: skip
        elif etype == "bulk_insert" and chars >= settings.paste_flag_chars:
            flag = IntegrityFlag(kind="bulk_insert", severity=0.5, fragment=str(data.get("text", ""))[:2000],
                                 detail={"chars": chars, "via": data.get("via", "")})  # fmt: skip
        elif etype == "type_segment" and chars >= 30:
            cpm = _cpm(chars, int(data.get("ms") or 0))
            # Transcription looks like long steady runs without pauses or revisions; authentic
            # composing has >=2 s planning pauses and edits (Crossley et al., 2024; Trezise et al., 2019)
            revisions = int(data.get("backspaces") or 0) / max(chars, 1)
            transcription_like = revisions < 0.03 and int(data.get("pauses_2s") or 0) == 0
            if cpm >= threshold and transcription_like:
                flag = IntegrityFlag(kind="burst", severity=min(1.0, 0.4 * cpm / threshold), fragment=str(data.get("text", ""))[:2000],
                                     detail={"chars": chars, "cpm": round(cpm), "threshold": round(threshold)})  # fmt: skip
        elif etype == "visibility" and stage == "exam" and not data.get("hidden") and int(data.get("away_ms") or 0) >= 5000:
            flag = IntegrityFlag(kind="tab_away", severity=0.3, detail={"away_ms": int(data["away_ms"])})

        if flag is not None:
            flag.user_id, flag.node_id, flag.stage = user.id, node_id, stage
            flag.task_id, flag.attempt_id, flag.target = ev_task, attempt_id, target
            db.add(flag)
            flags += 1
            if etype != "visibility":
                recent_away = False

    _update_baseline(user, baseline_samples)
    _update_writing_profile(user, [e.get("data") or {} for e in events if e.get("type") == "type_segment"])
    return flags


def _update_writing_profile(user: User, segments: list[dict[str, Any]]) -> None:
    """Running averages of writing-process features (exponential smoothing, alpha=0.2).

    burst_chars   — mean characters between >=2 s pauses (fluency; P-bursts)
    revision_rate — deletions per typed character (revising while writing)
    pause_rate    — >=2 s pauses per 100 characters (planning / cognitive effort)
    sentence_pause_share — share of long pauses at sentence starts (planning ahead vs. on the fly)
    iki_cv        — variability of inter-key intervals (rhythm steadiness)
    """
    segs = [s for s in segments if int(s.get("chars") or 0) >= 20]
    if not segs:
        return
    feats = {
        "burst_chars": mean(int(s["chars"]) / (int(s.get("pauses_2s") or 0) + 1) for s in segs),
        "revision_rate": mean(int(s.get("backspaces") or 0) / max(int(s["chars"]), 1) for s in segs),
        "pause_rate": mean(100 * int(s.get("pauses_2s") or 0) / max(int(s["chars"]), 1) for s in segs),
        "iki_cv": mean(float(s.get("iki_cv") or 0) for s in segs),
    }
    long_pauses = sum(int(s.get("pauses_2s") or 0) for s in segs)
    if long_pauses:
        feats["sentence_pause_share"] = sum(int(s.get("sentence_pauses") or 0) for s in segs) / long_pauses
    profile = dict(user.writing_profile or {})
    n = int(profile.get("segments", 0))
    for k, v in feats.items():
        old = profile.get(k)
        profile[k] = round(v if old is None or n == 0 else 0.8 * float(old) + 0.2 * v, 3)
    profile["segments"] = n + len(segs)
    user.writing_profile = profile


def describe_writing(profile: dict[str, Any]) -> list[str]:
    """Neutral, learning-oriented reading of the writing profile (never a diagnosis)."""
    if int(profile.get("segments", 0)) < 5:
        return []
    out = []
    rev, pause = float(profile.get("revision_rate", 0)), float(profile.get("pause_rate", 0))
    share = profile.get("sentence_pause_share")
    if share is not None and float(share) > 0.5 and rev < 0.08:
        out.append("обдумывает мысль заранее: длинные паузы перед предложениями, мало правок")
    elif rev >= 0.12:
        out.append("думает по ходу письма: часто правит и переформулирует")
    if float(profile.get("burst_chars", 0)) >= 60:
        out.append("пишет длинными связными фрагментами (беглость)")
    elif pause >= 3:
        out.append("часто останавливается подумать — короткие фрагменты между паузами")
    return out


def typing_state(user: User, recent: list[dict[str, Any]]) -> str:
    """Compare the last chat messages' typing to the learner's own baseline (cognitive load / fatigue hint)."""
    base = float(user.typing_baseline.get("cpm") or 0)
    samples = [t for t in recent if int(t.get("chars") or 0) >= 20 and int(t.get("ms") or 0) > 0]
    if base <= 0 or len(samples) < 2:
        return ""
    cpm = mean(_cpm(int(t["chars"]), int(t["ms"])) for t in samples)
    pauses = mean(100 * int(t.get("pauses_2s") or 0) / int(t["chars"]) for t in samples)
    ratio = cpm / base
    if ratio < 0.6 and pauses >= 2:
        return (
            f"Сейчас ученик печатает заметно медленнее своей нормы (~{ratio:.0%}) и часто останавливается — "
            "возможно, материал даётся тяжело или он устал. Упрости шаг, дай пример, при необходимости предложи короткий перерыв."
        )
    if ratio > 1.3 and pauses < 0.5:
        return "Ученик отвечает быстро и уверенно — можно повысить темп и сложность."
    return ""


def practice_flagged_concepts(db: Session, user_id: int, node_id: int) -> dict[str, int]:
    rows = db.execute(
        select(Task.concept, func.count(IntegrityFlag.id))
        .join(Task, Task.id == IntegrityFlag.task_id)
        .where(IntegrityFlag.user_id == user_id, IntegrityFlag.node_id == node_id, IntegrityFlag.stage == "practice")
        .group_by(Task.concept)
    ).all()
    return {c or "без понятия": n for c, n in rows}


def flags_for_attempt(db: Session, attempt_id: int) -> list[IntegrityFlag]:
    return list(db.scalars(select(IntegrityFlag).where(IntegrityFlag.attempt_id == attempt_id).order_by(IntegrityFlag.id)).all())


def user_stats(db: Session, user: User) -> dict[str, Any]:
    counts = Counter(
        dict(
            db.execute(
                select(IntegrityFlag.kind, func.count()).where(IntegrityFlag.user_id == user.id).group_by(IntegrityFlag.kind)
            ).all()
        )
    )
    since = utcnow() - timedelta(days=30)
    typed = db.scalar(
        select(func.count()).select_from(Event).where(Event.user_id == user.id, Event.type == "type_segment", Event.ts >= since)
    ) or 0
    pasted = db.scalar(
        select(func.count()).select_from(Event).where(Event.user_id == user.id, Event.type == "paste", Event.ts >= since)
    ) or 0
    total_events = db.scalar(select(func.count()).select_from(Event).where(Event.user_id == user.id)) or 0
    # Calibration: learners with AI access tend to overestimate what they learned (Lehmann et al., 2024)
    rated = db.execute(
        select(Task.confidence, Task.score).where(Task.user_id == user.id, Task.confidence.is_not(None), Task.score.is_not(None))
    ).all()
    calibration = None
    if rated:
        conf = sum(c for c, _ in rated) / len(rated)  # 1..5
        score = sum(s for _, s in rated) / len(rated)  # 0..100
        calibration = {"samples": len(rated), "confidence": round((conf - 1) / 4, 2), "accuracy": round(score / 100, 2)}
    return {
        "writing_profile": user.writing_profile,
        "writing_traits": describe_writing(user.writing_profile or {}),
        "calibration": calibration,
        "typing_cpm": user.typing_baseline.get("cpm"),
        "flags": dict(counts),
        "typed_segments_30d": typed,
        "pastes_30d": pasted,
        "total_events": total_events,
    }
