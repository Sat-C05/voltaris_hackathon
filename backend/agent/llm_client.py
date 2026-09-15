"""Thin wrapper around Ollama's native tool-calling `AsyncClient`.

The async client only: a blocking LLM call would freeze the world's simulated clock mid-run,
because this runs inside the same single asyncio event loop as the tick loop.

Gemma 4 ships native function-calling special tokens, so this is Ollama's `tools` API directly
— no hand-rolled JSON parsing or repair loop.
"""

from __future__ import annotations

import ollama

from backend import config


class LLMClient:
    def __init__(self, *, model: str = config.MODEL_NAME, num_ctx: int = config.MODEL_NUM_CTX,
                 host: str = config.OLLAMA_HOST, temperature: float = 0.2) -> None:
        self._client = ollama.AsyncClient(host=host)
        self.model = model
        self.num_ctx = num_ctx
        self.temperature = temperature

    async def chat(self, messages: list[dict], tools: list[dict]) -> ollama.Message:
        response = await self._client.chat(
            model=self.model,
            messages=messages,
            tools=tools,
            options={"num_ctx": self.num_ctx, "temperature": self.temperature},
        )
        return response.message
