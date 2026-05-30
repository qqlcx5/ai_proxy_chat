"""Agentic loop — call model → parse tool call → execute → feedback → repeat.

Supports both streaming and non-streaming modes.
"""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import config
from client import call_reverse_api
from tool_executor import execute_tool
from tool_parser import extract_tool_call, has_tool_call
from tool_prompt import build_system_prompt, format_tool_result

logger = logging.getLogger("gateway.agentic")


async def run_agentic_loop(
    system_prompt: str,
    messages: list[dict[str, Any]],
) -> tuple[dict | None, str]:
    """Non-streaming agentic loop.

    Returns (tool_call_or_none, final_text).
    """
    current_messages = list(messages)

    for round_num in range(config.MAX_TOOL_ROUNDS):
        logger.debug(f"  agentic loop round {round_num + 1}/{config.MAX_TOOL_ROUNDS}")

        raw = await call_reverse_api(system_prompt, current_messages, stream=False)
        assert isinstance(raw, str)
        logger.debug(f"    raw ({len(raw)} chars): {raw[:200]}")

        tool_call = extract_tool_call(raw)
        if tool_call is None:
            return None, raw

        logger.info(f"    tool_call: {tool_call['name']}({json.dumps(tool_call['arguments'], ensure_ascii=False)[:200]})")

        result = await execute_tool(tool_call["name"], tool_call["arguments"])
        logger.debug(f"    tool result ({len(result)} chars): {result[:200]}")

        # Feed result back as user message
        feedback = format_tool_result(tool_call["name"], result)
        current_messages.append({"role": "assistant", "content": raw})
        current_messages.append({"role": "user", "content": feedback})

    logger.warning(f"  agentic loop hit max rounds ({config.MAX_TOOL_ROUNDS})")
    return None, "Max tool rounds reached."


async def run_agentic_loop_streaming(
    system_prompt: str,
    messages: list[dict[str, Any]],
) -> AsyncIterator[str]:
    """Streaming agentic loop.

    Streams model output to the client. If a tool call is detected after
    the stream completes, executes it and loops (silently, not streamed
    to the client). Only the final text answer is streamed.
    """
    current_messages = list(messages)

    for round_num in range(config.MAX_TOOL_ROUNDS):
        logger.debug(f"  streaming agentic loop round {round_num + 1}/{config.MAX_TOOL_ROUNDS}")

        chunks: list[str] = []
        stream = await call_reverse_api(system_prompt, current_messages, stream=True)
        assert not isinstance(stream, str)

        async for chunk in stream:
            chunks.append(chunk)
            yield chunk

        full_text = "".join(chunks)
        logger.debug(f"    streamed ({len(full_text)} chars): {full_text[:200]}")

        # Check for tool call in the complete text
        if not has_tool_call(full_text):
            return

        tool_call = extract_tool_call(full_text)
        if tool_call is None:
            return

        logger.info(f"    tool_call: {tool_call['name']}({json.dumps(tool_call['arguments'], ensure_ascii=False)[:200]})")

        result = await execute_tool(tool_call["name"], tool_call["arguments"])
        logger.debug(f"    tool result ({len(result)} chars): {result[:200]}")

        # Feed result back and loop (the next stream will be yielded to the client)
        feedback = format_tool_result(tool_call["name"], result)
        current_messages.append({"role": "assistant", "content": full_text})
        current_messages.append({"role": "user", "content": feedback})

        # Yield a separator so the client knows a tool was used
        yield f"\n\n--- Tool `{tool_call['name']}` executed, continuing... ---\n\n"

    logger.warning(f"  streaming agentic loop hit max rounds ({config.MAX_TOOL_ROUNDS})")
