"""Learning sessions: when a session ends (logout, tab closed, or 30 min idle) the AI writes a summary
into MemPalace — the "use rarely, write at the end" part of the memory design."""

import asyncio
import logging
from collections import Counter
from datetime import timedelta

from sqlalchemy import select

from .. import memory
from ..db import SessionLocal
from ..llm import get_llm
from ..models import Course, Event, GraphNode, IntegrityFlag, LearningSession, Message, Task, User, utcnow
from ..prompts import SESSION_MEMORY_SCHEMA, SESSION_MEMORY_SYSTEM

log = logging.getLogger("meraki.sessions")
IDLE_MINUTES = 30


async def summarize_session(session_id: str) -> None:
    with SessionLocal() as db:
        sess = db.get(LearningSession, session_id)
        if sess is None or sess.summarized:
            return
        sess.summarized = True
        sess.ended_at = sess.ended_at or utcnow()
        db.commit()
        user = db.get(User, sess.user_id)
        start, end = sess.started_at, sess.ended_at
        events = db.scalars(select(Event).where(Event.session_id == session_id)).all()
        messages = db.scalars(
            select(Message).where(Message.user_id == sess.user_id, Message.created_at >= start, Message.created_at <= end).order_by(Message.id)
        ).all()
        if not events and not messages:
            return
        node_ids = {e.node_id for e in events if e.node_id} | {m.node_id for m in messages}
        nodes = db.scalars(select(GraphNode).where(GraphNode.id.in_(node_ids))).all() if node_ids else []
        course_titles = {
            n.course_id: (db.get(Course, n.course_id).title if db.get(Course, n.course_id) else "") for n in nodes
        }
        tasks = db.scalars(
            select(Task).where(Task.user_id == sess.user_id, Task.status == "graded", Task.created_at >= start - timedelta(days=1))
        ).all()
        flags = db.scalars(
            select(IntegrityFlag).where(IntegrityFlag.user_id == sess.user_id, IntegrityFlag.created_at >= start, IntegrityFlag.created_at <= end)
        ).all()
        counts = Counter(e.type for e in events)
        stages = Counter(e.stage for e in events if e.stage)
        dialogue = "\n".join(f"[{m.stage}] {'Ученик' if m.role == 'user' else 'Наставник'}: {m.content[:400]}" for m in messages[-40:])
        prompt = (
            f"Ученик: {user.name if user else sess.user_id}. Сессия {start:%Y-%m-%d %H:%M} – {end:%H:%M}.\n"
            f"Темы: {', '.join(f'«{n.title}» ({course_titles.get(n.course_id, '')})' for n in nodes)}\n"
            f"Этапы (по числу действий): {dict(stages)}\nДействия: {dict(counts)}\n"
            f"Оценённые задания: {[(t.title, t.stage, t.score) for t in tasks if t.node_id in node_ids][:10]}\n"
            f"Сигналы несамостоятельности: {[(f.kind, f.stage, round(f.severity, 2)) for f in flags][:15]}\n"
            f"Скорость печати (база): {user.typing_baseline.get('cpm') if user else None} зн/мин\n\n"
            f"Фрагменты диалогов:\n{dialogue}"
        )
        user_id = sess.user_id
        room = f"course_{nodes[0].course_id}" if nodes else "sessions"
    try:
        result = await get_llm().complete_json(system=SESSION_MEMORY_SYSTEM, prompt=prompt, schema=SESSION_MEMORY_SCHEMA, tier="fast")
    except Exception:
        log.exception("session summary failed")
        return
    await memory.remember(user_id, room, f"[Сессия {start:%Y-%m-%d}] {result.get('memory', '')}")
    for fact in result.get("facts", [])[:6]:
        await memory.add_fact(user_id, fact.get("predicate", "prefers"), str(fact.get("object", "")))


def end_session(session_id: str) -> bool:
    with SessionLocal() as db:
        sess = db.get(LearningSession, session_id)
        if sess is None or sess.ended_at is not None:
            return False
        sess.ended_at = utcnow()
        db.commit()
        return True


async def idle_sweeper() -> None:
    while True:
        try:
            await asyncio.sleep(300)
            cutoff = utcnow() - timedelta(minutes=IDLE_MINUTES)
            with SessionLocal() as db:
                stale = db.scalars(
                    select(LearningSession.id).where(LearningSession.summarized.is_(False), LearningSession.last_activity < cutoff)
                ).all()
                for sid in stale:
                    s = db.get(LearningSession, sid)
                    if s and s.ended_at is None:
                        s.ended_at = s.last_activity
                db.commit()
            for sid in stale:
                await summarize_session(sid)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("idle sweeper iteration failed")
