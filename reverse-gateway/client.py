"""Reverse API client — calls OpenAI-compatible chat completions endpoint.

Supports both streaming (SSE) and non-streaming modes.
"""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

import config

logger = logging.getLogger("gateway.client")


def _build_openai_messages(
    system_prompt: str,
    messages: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Convert to OpenAI chat format.

    Flattens Anthropic content blocks to plain text since the reverse API
    doesn't support native tool calling.
    """
    result: list[dict[str, str]] = []

    if system_prompt:
        result.append({"role": "system", "content": system_prompt})

    for msg in messages:
        role = msg["role"]
        content = msg.get("content", "")

        if isinstance(content, str):
            result.append({"role": role, "content": content})
        elif isinstance(content, list):
            text_parts: list[str] = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                    elif block.get("type") == "tool_use":
                        name = block.get("name", "")
                        inp = json.dumps(block.get("input", {}), ensure_ascii=False)
                        text_parts.append(
                            f'<tool_call_request>\n  <name>{name}</name>\n'
                            f'  <arguments>{inp}</arguments>\n</tool_call_request>'
                        )
                    elif block.get("type") == "tool_result":
                        res = block.get("content", "")
                        if isinstance(res, list):
                            res = "\n".join(
                                x.get("text", "") for x in res if isinstance(x, dict) and x.get("type") == "text"
                            )
                        text_parts.append(f"[Tool result]:\n{res}")
                elif isinstance(block, str):
                    text_parts.append(block)

            combined = "\n".join(text_parts)
            if combined:
                result.append({"role": role, "content": combined})

    return result


async def call_reverse_api(
    system_prompt: str,
    messages: list[dict[str, Any]],
    stream: bool = False,
) -> str | AsyncIterator[str]:
    """Call the reverse API. Returns full text or an async iterator of text chunks."""
    openai_messages = _build_openai_messages(system_prompt, messages)

    payload = {
        "model": config.REVERSE_MODEL,
        "messages": openai_messages,
        "stream": stream,
    }

    headers = {
        "Authorization": f"Bearer {config.REVERSE_API_KEY}",
        "Content-Type": "application/json",
    }

    url = f"{config.REVERSE_BASE_URL}/chat/completions"
    logger.debug(f"  POST {url}  stream={stream}  messages={len(openai_messages)}")

    if stream:
        return _stream_response(url, headers, payload)
    else:
        return await _sync_response(url, headers, payload)


async def _sync_response(url: str, headers: dict, payload: dict) -> str:
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        logger.debug(f"  response ({len(content)} chars)")
        return content


async def _stream_response(url: str, headers: dict, payload: dict) -> AsyncIterator[str]:
    """Stream SSE from the reverse API, yielding text content chunks."""
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            resp.raise_for_status()
            buffer = ""
            async for chunk in resp.aiter_text():
                buffer += chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            return
                        try:
                            data = json.loads(data_str)
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue
