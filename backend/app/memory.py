"""Long-term learner memory.

MemPalace (github.com/mempalace/mempalace) runs as a child MCP server over stdio; we talk to its
official tools (mempalace_add_drawer / mempalace_search / mempalace_kg_*). Layout:
  wing  = user_<id>             (one wing per learner)
  room  = course_<id> | sessions | profile
  drawer = verbatim summary text
Every write is mirrored into SQLite (memory_entries) so the UI can list it and so the app keeps
working (with keyword search) when MemPalace is unavailable.
"""

import asyncio
import json
import logging
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from sqlalchemy import select

from .config import BASE_DIR, settings
from .db import SessionLocal
from .models import MemoryEntry

log = logging.getLogger("meraki.memory")


class MemPalaceMCP:
    def __init__(self, command: list[str]) -> None:
        self._command = command
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._next_id = 0
        self.ready = False
        self.error = ""

    def _send(self, msg: dict[str, Any]) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        assert self._proc and self._proc.stdout
        self._next_id += 1
        req_id = self._next_id
        self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        while True:
            line = self._proc.stdout.readline()
            if not line:
                raise RuntimeError("MemPalace MCP завершился")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == req_id:
                if "error" in msg:
                    raise RuntimeError(str(msg["error"]))
                return msg.get("result") or {}

    def _start(self) -> None:
        self._proc = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env={**__import__("os").environ, "PYTHONIOENCODING": "utf-8"},
        )
        self._request(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "meraki", "version": "0.1"}},
        )
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                self._start()
            result = self._request("tools/call", {"name": tool, "arguments": arguments})
        text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            data = {"text": text}
        if result.get("isError"):
            raise RuntimeError(text[:300])
        return data

    def warm_up(self) -> None:
        try:
            # First write downloads the local embedding model (can take a few minutes once)
            self.call(
                "mempalace_add_drawer",
                {"wing": "meraki_system", "room": "boot", "content": "Meraki memory initialized.", "added_by": "meraki"},
            )
            self.ready = True
            log.info("MemPalace ready")
        except Exception as e:
            self.error = str(e)
            log.warning("MemPalace unavailable, using SQLite fallback: %s", e)

    def close(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()


def _default_command() -> list[str]:
    if settings.mempalace_command:
        return settings.mempalace_command.split()
    scripts = BASE_DIR / ".venv" / ("Scripts" if sys.platform == "win32" else "bin")
    exe = scripts / ("mempalace-mcp.exe" if sys.platform == "win32" else "mempalace-mcp")
    return [str(exe if exe.exists() else Path("mempalace-mcp")), "--palace", str(settings.palace_path)]


_palace: MemPalaceMCP | None = None


def start_memory() -> None:
    global _palace
    if settings.memory_backend != "mempalace":
        return
    _palace = MemPalaceMCP(_default_command())
    threading.Thread(target=_palace.warm_up, daemon=True).start()


def stop_memory() -> None:
    if _palace:
        _palace.close()


def memory_status() -> dict[str, Any]:
    if _palace is None:
        return {"backend": "sqlite", "ready": True}
    return {"backend": "mempalace", "ready": _palace.ready, "error": _palace.error}


def _instance_id() -> str:
    f = settings.data_dir / "instance_id"
    if not f.exists():
        import uuid

        f.write_text(uuid.uuid4().hex[:8], encoding="utf-8")
    return f.read_text(encoding="utf-8").strip()


def _wing(user_id: int) -> str:
    return f"m{_instance_id()}_user_{user_id}"


def _palace_ok() -> bool:
    return _palace is not None and _palace.ready


async def remember(user_id: int, room: str, content: str) -> None:
    drawer_id = ""
    if _palace_ok():
        try:
            res = await asyncio.to_thread(
                _palace.call,  # type: ignore[union-attr]
                "mempalace_add_drawer",
                {"wing": _wing(user_id), "room": room, "content": content, "added_by": "meraki"},
            )
            drawer_id = str(res.get("drawer_id", ""))
        except Exception as e:
            log.warning("MemPalace write failed: %s", e)
    with SessionLocal() as db:
        db.add(MemoryEntry(user_id=user_id, wing=_wing(user_id), room=room, content=content, drawer_id=drawer_id))
        db.commit()


async def recall(user_id: int, query: str, limit: int = 4) -> list[str]:
    if _palace_ok():
        try:
            res = await asyncio.to_thread(
                _palace.call,  # type: ignore[union-attr]
                "mempalace_search",
                {"query": query[:240], "wing": _wing(user_id), "limit": limit},
            )
            return [r["text"] for r in res.get("results", []) if r.get("text")]
        except Exception as e:
            log.warning("MemPalace search failed: %s", e)
    # Fallback: crude keyword overlap over the local mirror
    words = {w for w in query.lower().split() if len(w) > 3}
    with SessionLocal() as db:
        rows = db.scalars(
            select(MemoryEntry).where(MemoryEntry.user_id == user_id).order_by(MemoryEntry.id.desc()).limit(200)
        ).all()
    scored = sorted(rows, key=lambda r: -sum(w in r.content.lower() for w in words))
    return [r.content for r in scored[:limit]]


async def add_fact(user_id: int, predicate: str, obj: str) -> None:
    """Temporal knowledge-graph fact about the learner, e.g. (user_3, mastered, рекурсия)."""
    if not _palace_ok():
        return
    try:
        await asyncio.to_thread(
            _palace.call,  # type: ignore[union-attr]
            "mempalace_kg_add",
            {"subject": _wing(user_id), "predicate": predicate, "object": obj[:120]},
        )
    except Exception as e:
        log.warning("MemPalace kg_add failed: %s", e)


async def facts(user_id: int) -> list[dict[str, Any]]:
    if not _palace_ok():
        return []
    try:
        res = await asyncio.to_thread(
            _palace.call,  # type: ignore[union-attr]
            "mempalace_kg_query",
            {"entity": _wing(user_id), "direction": "outgoing"},
        )
        return list(res.get("facts") or res.get("results") or [])
    except Exception as e:
        log.warning("MemPalace kg_query failed: %s", e)
        return []
