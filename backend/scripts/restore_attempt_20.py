"""Repair exam attempt 20 (tree@gmail.com) from the first submission found in the WAL.

The first submission saved full answers for tasks 132/133, then a failed grading job left the
attempt in_progress. The retry sent empty fields and overwrote the saved answers. This script
recovers the rendered submissions from the SQLite WAL, restores them and re-runs grading from
the saved answers. The defence of the solution (understanding=0.86) is kept, so the learner
does not have to answer the verification questions again.

Run from backend/:
    .venv/Scripts/python.exe -X utf8 scripts/restore_attempt_20.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.config import settings  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.models import ExamAttempt, NodeProgress, Task  # noqa: E402
from app.services import learning  # noqa: E402

ATTEMPT_ID = 20
PREFIX = "Ответ ученика:"
ANSWER_PREFIX = PREFIX + "\n"


def raw_answer(rendered: str) -> str:
    """The textarea part of a rendered submission (without attached files/canvas)."""
    body = rendered[len(ANSWER_PREFIX):] if rendered.startswith(ANSWER_PREFIX) else rendered
    for marker in ("\n\nФайл ", "\n\nХолст "):
        cut = body.find(marker)
        if cut >= 0:
            body = body[:cut]
            break
    body = body.strip("\n")
    return "" if body.strip() == "(пусто)" else body


def extract_submission(data: bytes, start: int, marker: str) -> str | None:
    """Cut one rendered submission from ``start`` through the closing fence of its file block."""
    needle = PREFIX.encode("utf-8")
    marker_pos = data.find(marker.encode("utf-8"), start)
    if marker_pos < 0:
        return None
    # The marker must belong to this submission, not to a later one in the WAL.
    next_submission = data.find(needle, start + len(needle))
    if 0 <= next_submission < marker_pos:
        return None
    fence_open = data.find(b"```\n", marker_pos)
    if fence_open < 0:
        return None
    fence_close = data.find(b"\n```", fence_open + 4)
    if fence_close < 0:
        return None
    return data[start : fence_close + 4].decode("utf-8", "replace")


def find_submission(wal: bytes, raw_marker: str, file_marker: str) -> str:
    """Find the first submission whose raw answer starts with ``raw_marker``.

    WAL pages are not a linear record log, so scanning every prefix can stitch bytes from
    different pages together. The raw answer text is unique enough to anchor the search.
    """
    raw_pos = wal.find(raw_marker.encode("utf-8"))
    if raw_pos < 0:
        raise SystemExit(f"Не нашёл ответ с началом {raw_marker!r} в WAL")
    start = wal.rfind(PREFIX.encode("utf-8"), 0, raw_pos)
    if start < 0:
        raise SystemExit(f"Не нашёл начало отправки для {raw_marker!r}")
    rendered = extract_submission(wal, start, file_marker)
    if rendered is None or not raw_answer(rendered).startswith(raw_marker):
        raise SystemExit(f"Не удалось извлечь отправку для {raw_marker!r}")
    return rendered


def main() -> None:
    init_db()
    wal_path = settings.db_path.with_name(settings.db_path.name + "-wal")
    if not wal_path.exists():
        raise SystemExit(f"Нет файла WAL: {wal_path}")
    wal = wal_path.read_bytes()

    recovered = {
        "1.5_": find_submission(wal, "sensor - итерируемый", "inspect.py"),
        "1.6_": find_submission(wal, "start\nerror\nstop\n\nберёт элементы", "loglines.py"),
    }

    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, ATTEMPT_ID)
        if attempt is None:
            raise SystemExit(f"Попытка {ATTEMPT_ID} не найдена")
        tasks = db.scalars(select(Task).where(Task.attempt_id == ATTEMPT_ID).order_by(Task.id)).all()
        if len(tasks) != 3:
            raise SystemExit(f"Ожидалось 3 задания, найдено {len(tasks)}")
        if attempt.status == "finished" and (attempt.score or 0) >= learning.PASS_SCORE:
            print("Попытка уже восстановлена и зачтена; повторный запуск не нужен.")
            return

        # Backfill the new column for every older task from its rendered submission.
        backfilled = 0
        for task in db.scalars(select(Task)).all():
            if (task.submitted_answer or "").strip():
                continue
            raw = raw_answer(task.answer or "")
            if raw:
                task.submitted_answer = raw
                backfilled += 1

        restored = 0
        for task in tasks:
            folder = task.workspace_folder or ""
            for prefix, rendered in recovered.items():
                if folder.startswith(prefix) or f"/{prefix}" in folder:
                    task.answer = rendered
                    task.submitted_answer = raw_answer(rendered)
                    restored += 1
                    print(f"restored task {task.id}: {task.title} ({len(task.submitted_answer)} chars)")
                    break
        if restored != 2:
            raise SystemExit(f"Восстановлено {restored} задания вместо 2")
        db.commit()

    print(f"backfilled submitted_answer for {backfilled} old task(s)")
    print("re-grading attempt", ATTEMPT_ID, "...")
    asyncio.run(learning.regrade_exam(ATTEMPT_ID))

    with SessionLocal() as db:
        attempt = db.get(ExamAttempt, ATTEMPT_ID)
        progress = db.scalar(
            select(NodeProgress).where(
                NodeProgress.user_id == attempt.user_id, NodeProgress.node_id == attempt.node_id
            )
        )
        print("status:", attempt.status)
        print("raw_score:", attempt.raw_score)
        print("understanding:", attempt.understanding)
        print("score:", attempt.score)
        print("completed:", bool(progress and progress.completed), "stage:", progress.stage if progress else None)
        for task in db.scalars(select(Task).where(Task.attempt_id == ATTEMPT_ID).order_by(Task.id)):
            print(f"  task {task.id}: {task.score} — {task.title}")


if __name__ == "__main__":
    main()
