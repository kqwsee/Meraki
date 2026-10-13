import json
import re
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any


class LLMError(RuntimeError):
    pass


class LLMProvider(ABC):
    """A teacher model. `tier` is "fast" (dialogue) or "smart" (course structuring, grading)."""

    name: str = "base"

    @abstractmethod
    async def complete_text(self, *, system: str, prompt: str, tier: str = "fast") -> str: ...

    @abstractmethod
    async def complete_json(self, *, system: str, prompt: str, schema: dict[str, Any], tier: str = "fast") -> dict[str, Any]: ...

    @abstractmethod
    def stream(self, *, system: str, prompt: str, tier: str = "fast") -> AsyncIterator[str]: ...


_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def extract_json(text: str) -> dict[str, Any]:
    """Tolerant JSON extraction for providers without native structured output."""
    text = text.strip()
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    m = _FENCE_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    raise LLMError("Модель вернула некорректный JSON")
