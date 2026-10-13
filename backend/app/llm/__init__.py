from functools import lru_cache

from ..config import settings
from .base import LLMError, LLMProvider


@lru_cache(maxsize=1)
def get_llm() -> LLMProvider:
    if settings.llm_provider == "openai":
        from .openai_compat import OpenAICompatProvider

        return OpenAICompatProvider()
    from .claude_cli import ClaudeCliProvider

    return ClaudeCliProvider()


__all__ = ["LLMError", "LLMProvider", "get_llm"]
