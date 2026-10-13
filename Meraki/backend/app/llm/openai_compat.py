"""Any OpenAI-compatible chat completions endpoint (OpenAI, OpenRouter, Ollama, LM Studio, vLLM...)."""

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..config import settings
from .base import LLMError, LLMProvider, extract_json


class OpenAICompatProvider(LLMProvider):
    name = "openai"

    def __init__(self) -> None:
        headers = {"Authorization": f"Bearer {settings.openai_api_key}"} if settings.openai_api_key else {}
        self._client = httpx.AsyncClient(
            base_url=settings.openai_base_url.rstrip("/"), headers=headers, timeout=settings.llm_timeout_seconds
        )

    def _model(self, tier: str) -> str:
        return settings.llm_model_smart if tier == "smart" else settings.llm_model_fast

    def _body(self, system: str, prompt: str, tier: str, **extra: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self._model(tier),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        }
        if settings.llm_max_tokens > 0:
            body["max_tokens"] = settings.llm_max_tokens
        body.update(extra)
        return body

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        resp = await self._client.post("/chat/completions", json=body)
        if resp.status_code >= 400:
            raise LLMError(f"LLM API {resp.status_code}: {resp.text[:500]}")
        return resp.json()

    async def complete_text(self, *, system: str, prompt: str, tier: str = "fast") -> str:
        data = await self._post(self._body(system, prompt, tier))
        return data["choices"][0]["message"]["content"] or ""

    async def complete_json(self, *, system: str, prompt: str, schema: dict[str, Any], tier: str = "fast") -> dict[str, Any]:
        strict = {"type": "json_schema", "json_schema": {"name": "result", "schema": schema}}
        try:
            data = await self._post(self._body(system, prompt, tier, response_format=strict))
        except LLMError:
            # Endpoint without json_schema support: describe the schema in the prompt instead
            hint = f"\n\nВерни ТОЛЬКО JSON по схеме:\n{json.dumps(schema, ensure_ascii=False)}"
            data = await self._post(self._body(system, prompt + hint, tier, response_format={"type": "json_object"}))
        return extract_json(data["choices"][0]["message"]["content"] or "")

    async def stream(self, *, system: str, prompt: str, tier: str = "fast") -> AsyncIterator[str]:
        body = self._body(system, prompt, tier, stream=True)
        async with self._client.stream("POST", "/chat/completions", json=body) as resp:
            if resp.status_code >= 400:
                raise LLMError(f"LLM API {resp.status_code}: {(await resp.aread()).decode()[:500]}")
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                choices = chunk.get("choices") or []
                if choices:
                    text = (choices[0].get("delta") or {}).get("content")
                    if text:
                        yield text
