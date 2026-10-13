"""Claude through the user's subscription: runs the headless Claude Code CLI (`claude -p`).

Every call is stateless: the conversation history is rendered into the prompt, tools are disabled,
user customizations are skipped (--safe-mode) and nothing is persisted to the CLI session history.
The subprocess runs in a worker thread so it works under any asyncio event loop on Windows.
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from ..config import settings
from .base import LLMError, LLMProvider

log = logging.getLogger("meraki.llm")

# Session-scoped variables of a parent Claude Code process must not leak into the child CLI,
# and an API key would switch billing away from the subscription.
_KEEP_ENV = {"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"}


def _resolve_cli() -> str:
    if settings.claude_cli_path:
        return settings.claude_cli_path
    found = shutil.which("claude")
    if not found:
        raise LLMError("Claude CLI не найден. Установите Claude Code и выполните вход (`claude`), или укажите CLAUDE_CLI_PATH.")
    if sys.platform == "win32" and found.lower().endswith((".cmd", ".ps1")):
        # npm shim -> call the native binary directly (cmd.exe limits arguments to 8K chars)
        native = Path(found).parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        if native.exists():
            return str(native)
    return found


def _child_env() -> dict[str, str]:
    env = {
        k: v
        for k, v in os.environ.items()
        if k in _KEEP_ENV or not (k.startswith("CLAUDE") or k.startswith("ANTHROPIC"))
    }
    env["PYTHONIOENCODING"] = "utf-8"
    return env


class ClaudeCliProvider(LLMProvider):
    name = "claude_cli"

    def __init__(self) -> None:
        self._exe = _resolve_cli()
        self._env = _child_env()
        self._cwd = settings.data_dir / "llm_sandbox"
        self._cwd.mkdir(parents=True, exist_ok=True)
        self._sem: asyncio.Semaphore | None = None

    def _semaphore(self) -> asyncio.Semaphore:
        if self._sem is None:
            self._sem = asyncio.Semaphore(settings.llm_max_concurrency)
        return self._sem

    def _model(self, tier: str) -> str:
        return settings.llm_model_smart if tier == "smart" else settings.llm_model_fast

    def _base_args(self, tier: str, system_file: str) -> list[str]:
        return [
            self._exe, "-p",
            "--model", self._model(tier),
            "--tools", "",
            "--safe-mode",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--effort", settings.claude_effort,
            "--system-prompt-file", system_file,
        ]  # fmt: skip

    def _write_system(self, system: str) -> str:
        fd, path = tempfile.mkstemp(prefix="sys_", suffix=".txt", dir=self._cwd)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(system)
        return path

    def _run(self, args: list[str], prompt: str) -> dict[str, Any]:
        proc = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env=self._env,
            cwd=self._cwd,
            timeout=settings.llm_timeout_seconds,
        )
        out = proc.stdout.strip()
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            raise LLMError(f"Claude CLI: неожиданный ответ (код {proc.returncode}): {(proc.stderr or out)[:500]}")
        if data.get("is_error"):
            raise LLMError(f"Claude CLI: {str(data.get('result'))[:500]}")
        log.info("claude_cli %s cost=$%s %sms", args[3], data.get("total_cost_usd"), data.get("duration_ms"))
        return data

    async def _call(self, *, system: str, prompt: str, tier: str, extra: list[str]) -> dict[str, Any]:
        system_file = self._write_system(system)
        try:
            args = self._base_args(tier, system_file) + ["--output-format", "json", *extra]
            async with self._semaphore():
                return await asyncio.to_thread(self._run, args, prompt)
        finally:
            Path(system_file).unlink(missing_ok=True)

    async def complete_text(self, *, system: str, prompt: str, tier: str = "fast") -> str:
        data = await self._call(system=system, prompt=prompt, tier=tier, extra=[])
        return str(data.get("result") or "")

    async def complete_json(self, *, system: str, prompt: str, schema: dict[str, Any], tier: str = "fast") -> dict[str, Any]:
        data = await self._call(
            system=system, prompt=prompt, tier=tier, extra=["--json-schema", json.dumps(schema, ensure_ascii=False)]
        )
        result = data.get("structured_output")
        if not isinstance(result, dict):
            from .base import extract_json

            result = extract_json(str(data.get("result") or ""))
        return result

    async def stream(self, *, system: str, prompt: str, tier: str = "fast") -> AsyncIterator[str]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        system_file = self._write_system(system)
        args = self._base_args(tier, system_file) + [
            "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        ]  # fmt: skip
        proc_holder: dict[str, subprocess.Popen] = {}

        def put(kind: str, value: str) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, (kind, value))

        def worker() -> None:
            try:
                proc = subprocess.Popen(
                    args,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    encoding="utf-8",
                    errors="replace",
                    env=self._env,
                    cwd=self._cwd,
                )
                proc_holder["p"] = proc
                assert proc.stdin and proc.stdout
                proc.stdin.write(prompt)
                proc.stdin.close()
                streamed = False
                for line in proc.stdout:
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if ev.get("type") == "stream_event":
                        inner = ev.get("event") or {}
                        delta = inner.get("delta") or {}
                        if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                            streamed = True
                            put("delta", delta.get("text", ""))
                    elif ev.get("type") == "result":
                        if ev.get("is_error"):
                            put("error", str(ev.get("result"))[:500])
                        elif not streamed and ev.get("result"):
                            put("delta", str(ev["result"]))
                proc.wait(timeout=30)
                if proc.returncode not in (0, None) and not streamed:
                    put("error", (proc.stderr.read() if proc.stderr else "")[:500] or f"код {proc.returncode}")
            except Exception as e:  # surfaced to the caller as LLMError
                put("error", str(e))
            finally:
                put("end", "")

        async with self._semaphore():
            thread = threading.Thread(target=worker, daemon=True)
            thread.start()
            try:
                while True:
                    kind, value = await asyncio.wait_for(queue.get(), timeout=settings.llm_timeout_seconds)
                    if kind == "delta":
                        yield value
                    elif kind == "error":
                        raise LLMError(f"Claude CLI: {value}")
                    else:
                        break
            finally:
                proc = proc_holder.get("p")
                if proc and proc.poll() is None:
                    proc.kill()
                Path(system_file).unlink(missing_ok=True)
