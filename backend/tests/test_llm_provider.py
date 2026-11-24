"""finish_reason=length must be reported as a token-budget error, not as bad JSON."""

import json
import unittest
from unittest.mock import AsyncMock, patch

from app.config import settings
from app.llm.base import LLMError
from app.llm.openai_compat import OpenAICompatProvider


def response(content: str = "", finish: str = "stop", completion: int = 100, reasoning: int = 0) -> dict:
    return {
        "choices": [{"message": {"content": content}, "finish_reason": finish}],
        "usage": {
            "completion_tokens": completion,
            "completion_tokens_details": {"reasoning_tokens": reasoning},
        },
    }


class FakeStream:
    status_code = 200

    def __init__(self, lines: list[str]):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return b""


class FinishReasonTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.provider = OpenAICompatProvider()

    async def asyncTearDown(self):
        await self.provider._client.aclose()

    async def test_complete_text_reports_token_exhaustion(self):
        self.provider._post = AsyncMock(return_value=response("обрыв", "length", 16000, 16000))
        with patch.object(settings, "llm_max_tokens", 16000):
            with self.assertRaises(LLMError) as ctx:
                await self.provider.complete_text(system="s", prompt="p")
        message = str(ctx.exception)
        self.assertIn("лимит токенов", message)
        self.assertIn("finish_reason=length", message)
        self.assertIn("reasoning_tokens=16000", message)
        self.assertIn("LLM_MAX_TOKENS=16000", message)

    async def test_truncated_json_response_does_not_trigger_a_blind_retry(self):
        post = AsyncMock(return_value=response('{"tasks": [', "length", 16000, 15990))
        self.provider._post = post
        with patch.object(settings, "llm_max_tokens", 16000):
            with self.assertRaises(LLMError) as ctx:
                await self.provider.complete_json(system="s", prompt="p", schema={"type": "object"})
        self.assertIn("finish_reason=length", str(ctx.exception))
        self.assertEqual(post.await_count, 1)  # no json_object fallback: it would burn another budget

    async def test_complete_json_still_falls_back_on_http_error(self):
        post = AsyncMock(side_effect=[LLMError("LLM API 400"), response('{"tasks": []}', "stop", 100, 20)])
        self.provider._post = post
        result = await self.provider.complete_json(system="s", prompt="p", schema={"type": "object"})
        self.assertEqual(result, {"tasks": []})
        self.assertEqual(post.await_count, 2)

    async def test_stream_reports_token_exhaustion_after_partial_text(self):
        lines = [
            'data: {"choices":[{"delta":{"content":"начало"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
            "data: [DONE]",
        ]
        self.provider._client.stream = lambda *_a, **_k: FakeStream(lines)
        chunks: list[str] = []
        with patch.object(settings, "llm_max_tokens", 16000):
            with self.assertRaises(LLMError) as ctx:
                async for chunk in self.provider.stream(system="s", prompt="p"):
                    chunks.append(chunk)
        self.assertEqual(chunks, ["начало"])
        self.assertIn("finish_reason=length", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
