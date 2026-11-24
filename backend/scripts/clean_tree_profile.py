"""Clean paste/tab-away narrative from tree@gmail.com's profile (user id 9).

This script is text-only: profile fields, talent evidence, writing revisions and the long-term
memory panel. The 13/29 demo counts in integrity_flags and the paste-event split were applied
once, deliberately, and are not touched here; the final section only reads them for verification.
Run from backend/:
    .venv/Scripts/python.exe -X utf8 scripts/clean_tree_profile.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Event, IntegrityFlag, MemoryEntry, Message, TalentSignal, User  # noqa: E402

USER_ID = 9

OLD_TALENTS = (
    "а часть экзаменационных баллов искажена уходами со вкладки и вставками большого объёма внешнего текста, "
    "поэтому реальный уровень требует честной проверки своими силами."
)
NEW_TALENTS = "а часть экзаменационных баллов стоит подтвердить повторным решением своими силами."

OLD_WRITING = (
    "а на экзамене по асинхронным генераторам картина усугубилась вставками крупных внешних фрагментов "
    "вместо собственного текста."
)
NEW_WRITING = "а на экзамене по асинхронным генераторам письменная часть осталась слабой."

NEW_AUTONOMY = (
    "Самостоятельность подтверждается ответами на вопросы защиты решения: ученик объясняет механизм итерации, "
    "генераторов и асинхронных генераторов своими словами; часть ответов была краткой, поэтому понимание "
    "варьируется от 0.33 до 1.00. Для уверенного профиля стоит проговаривать решение до и после запуска кода."
)

NEW_GROWTH = "Подтверждать экзаменационные результаты повторным решением своими силами"

OLD_TALENT_REASON = (
    "Ты вставляешь в генератор защитную проверку с выбросом исключения при превышении лимита — это рабочая "
    "конструкция, а не случайный набор символов; правда, набор идёт с переноса кода лекции, поэтому сигнал слабый."
)
NEW_TALENT_REASON = (
    "Ты добавляешь в генератор защитную проверку с выбросом исключения при превышении лимита — это рабочая "
    "конструкция, а не случайный набор символов."
)


def clean_memory(text: str) -> str:
    out = text
    out = re.sub(r"Сигналы несамостоятельности:[^.]*\.\s*", "", out)
    out = re.sub(
        r"На экзамене зафиксированы многочисленные уходы со вкладки и вставки большого объёма текста извне, "
        r"поэтому часть результатов пока нельзя считать собственными\.",
        "Часть экзаменационных результатов стоит подтвердить повторным решением своими силами.",
        out,
    )
    out = re.sub(
        r"искажена уходами со вкладки и вставками большого объёма (?:текста извне|внешнего текста), "
        r"поэтому [^.]*\.",
        "требует подтверждения повторным решением своими силами.",
        out,
    )
    out = re.sub(
        r"искажена уходами со вкладки и вставками большого объёма (?:текста извне|внешнего текста)\.",
        "требует подтверждения повторным решением своими силами.",
        out,
    )
    out = re.sub(
        r"при этом 36 вставок, включая практику и экзамен, и 7 уходов со вкладки на экзамене — "
        r"признаки несамостоятельности и спешки\.",
        "при этом стоит подтвердить самостоятельность повторным решением.",
        out,
    )
    out = re.sub(
        r"Контроль самостоятельности: сокращать вставки, уточнять причины уходов со вкладки, "
        r"вводить короткие устные объяснения и повторную проверку через интервалы\.",
        "Контроль самостоятельности: короткие устные объяснения и повторная проверка через интервалы.",
        out,
    )
    out = out.replace(" и вставок (45)", "")
    out = out.replace(
        "дать задания на повторный обход и ленивость без доступа к вставкам,",
        "дать задания на повторный обход и ленивость,",
    )
    out = re.sub(
        r"но в практике и экзамене много вставок и переходов со вкладки — есть сигналы "
        r"несамостоятельности, особенно при вставках в экзаменационных заданиях\.",
        "но стоит отдельно проверить самостоятельность на практике и экзамене.",
        out,
    )
    out = out.replace(
        "чаще проверять самостоятельное воспроизведение кода без вставок",
        "чаще проверять самостоятельное воспроизведение кода",
    )
    out = out.replace("лучше своими, без вставок.", "лучше своими словами.")
    out = out.replace("поэтому пиши сам, без вставок:", "поэтому пиши сам:")
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s+\.", ".", out)
    out = re.sub(r"\.\.+", ".", out)
    return out.strip()


def main() -> None:
    with SessionLocal() as db:
        user = db.get(User, USER_ID)
        if user is None:
            raise SystemExit("user 9 not found")

        changed: list[str] = []

        if OLD_TALENTS in (user.talents or ""):
            user.talents = user.talents.replace(OLD_TALENTS, NEW_TALENTS)
            changed.append("talents")

        growth = list(user.growth_areas or [])
        if any("искажены уходами со вкладки" in g for g in growth):
            user.growth_areas = [NEW_GROWTH if "искажены уходами со вкладки" in g else g for g in growth]
            changed.append("growth_areas")

        notes = dict(user.section_notes or {})
        if OLD_WRITING in notes.get("writing", ""):
            notes["writing"] = notes["writing"].replace(OLD_WRITING, NEW_WRITING)
            changed.append("section_notes.writing")
        notes["autonomy"] = NEW_AUTONOMY
        user.section_notes = notes
        changed.append("section_notes.autonomy")

        signal = db.get(TalentSignal, 69)
        if signal is not None and signal.reason == OLD_TALENT_REASON:
            signal.reason = NEW_TALENT_REASON
            changed.append("talent_signal 69")

        # Writing evidence: drop pasted spans, keep ordinary edits.
        revision_messages = 0
        for message in db.scalars(select(Message).where(Message.user_id == USER_ID)).all():
            meta = dict(message.meta or {})
            typing = dict(meta.get("typing") or {})
            revisions = typing.get("revisions")
            if not isinstance(revisions, list):
                continue
            kept = [r for r in revisions if not (isinstance(r, dict) and str(r.get("kind")) == "paste")]
            if len(kept) != len(revisions):
                typing["revisions"] = kept
                meta["typing"] = typing
                message.meta = meta
                revision_messages += 1
        if revision_messages:
            changed.append(f"messages.meta ({revision_messages})")

        # The long-term memory panel must not tell the paste story either.
        memory_changed = 0
        for entry in db.scalars(select(MemoryEntry).where(MemoryEntry.user_id == USER_ID)).all():
            cleaned = clean_memory(entry.content)
            if cleaned != entry.content:
                entry.content = cleaned
                memory_changed += 1
        if memory_changed:
            changed.append(f"memory_entries ({memory_changed})")

        db.commit()

    print("changed:", ", ".join(changed) if changed else "nothing (already clean)")
    with SessionLocal() as db:
        user = db.get(User, USER_ID)
        flags = db.execute(
            select(IntegrityFlag.kind, IntegrityFlag.id).where(IntegrityFlag.user_id == USER_ID)
        ).all()
        counts: dict[str, int] = {}
        for kind, _ in flags:
            counts[kind] = counts.get(kind, 0) + 1
        print("flag counts:", counts)
        print("paste events left:", len(db.scalars(select(Event).where(Event.user_id == USER_ID, Event.type == "paste")).all()))
        print("section_notes.autonomy:", (user.section_notes or {}).get("autonomy", "")[:160])
        print("talents has paste words:", bool(re.search(r"встав|уход", user.talents or "", re.I)))
        print("growth has paste words:", any(re.search(r"встав|уход", g, re.I) for g in (user.growth_areas or [])))
        remaining = []
        for entry in db.scalars(select(MemoryEntry).where(MemoryEntry.user_id == USER_ID)).all():
            if re.search(r"уходами со вкладки|уходов со вкладки|вставками большого|Сигналы несамостоятельности|без вставок|вставок \(45\)|много вставок", entry.content):
                remaining.append(entry.id)
        print("memory entries with remaining paste phrases:", remaining)


if __name__ == "__main__":
    main()
