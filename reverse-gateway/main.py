"""Reverse Gateway — Anthropic Messages API compatible server.

Accepts Anthropic Messages API requests, converts to OpenAI format,
calls a reverse API, and returns Anthropic-compatible responses.
Supports streaming via SSE and tool calling via prompt-injected agentic loop.
"""

import json
import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import config
from agentic import run_agentic_loop, run_agentic_loop_streaming
from tool_prompt import build_system_prompt, needs_tool_injection

app = FastAPI(title="Reverse Gateway")
logger = logging.getLogger("gateway")


def _extract_system_text(system: str | list | None) -> str:
    if system is None:
        return ""
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        parts = []
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(parts)
    return ""


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """Pass through messages, converting Pydantic models to dicts if needed."""
    result = []
    for msg in messages:
        if isinstance(msg, dict):
            result.append(msg)
        elif hasattr(msg, "model_dump"):
            result.append(msg.model_dump())
        else:
            result.append(dict(msg))
    return result


def _to_anthropic_response(tool_call: dict | None, text: str, model: str) -> dict:
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    if tool_call:
        return {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [
                {
                    "type": "tool_use",
                    "id": f"toolu_{uuid.uuid4().hex[:24]}",
                    "name": tool_call["name"],
                    "input": tool_call["arguments"],
                }
            ],
            "stop_reason": "tool_use",
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }

    return {
        "id": msg_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


def _make_sse(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _stream_anthropic_response(
    system_prompt: str,
    messages: list[dict],
    model: str,
    msg_id: str,
):
    """Yield Anthropic streaming SSE events."""
    block_index = 0
    block_id = f"msg_block_{uuid.uuid4().hex[:24]}"

    # message_start
    yield _make_sse("message_start", {
        "type": "message_start",
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        },
    })

    # content_block_start
    yield _make_sse("content_block_start", {
        "type": "content_block_start",
        "index": block_index,
        "content_block": {"type": "text", "text": ""},
    })

    # Stream content from agentic loop
    total_chars = 0
    async for chunk in run_agentic_loop_streaming(system_prompt, messages):
        total_chars += len(chunk)
        yield _make_sse("content_block_delta", {
            "type": "content_block_delta",
            "index": block_index,
            "delta": {"type": "text_delta", "text": chunk},
        })

    # content_block_stop
    yield _make_sse("content_block_stop", {
        "type": "content_block_stop",
        "index": block_index,
    })

    # message_delta + message_stop
    yield _make_sse("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
        "usage": {"output_tokens": 0},
    })

    yield _make_sse("message_stop", {"type": "message_stop"})


@app.post("/v1/messages")
async def handle_messages(request: Request):
    body = await request.json()

    model = body.get("model", config.REVERSE_MODEL)
    raw_messages = body.get("messages", [])
    raw_system = body.get("system")
    raw_tools = body.get("tools", [])
    stream = body.get("stream", False)

    logger.info(f">>> request  model={model}  tools={len(raw_tools)}  messages={len(raw_messages)}  stream={stream}")

    # Build system prompt
    system_text = _extract_system_text(raw_system)
    tools = [t if isinstance(t, dict) else t.model_dump() for t in raw_tools]
    system_prompt = build_system_prompt(system_text, tools)

    # If tools are provided but the last message doesn't trigger keyword injection,
    # we still include the tool prompt in the system message (already done by build_system_prompt)
    messages = _normalize_messages(raw_messages)

    if stream:
        msg_id = f"msg_{uuid.uuid4().hex[:24]}"
        return StreamingResponse(
            _stream_anthropic_response(system_prompt, messages, model, msg_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming
    tool_call, text = await run_agentic_loop(system_prompt, messages)

    if tool_call:
        logger.info(f"<<< response tool_call  name={tool_call['name']}")
    else:
        logger.info(f"<<< response text ({len(text)} chars): {text[:120]}")

    return JSONResponse(_to_anthropic_response(tool_call, text, model))


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(
        level=logging.DEBUG if config.DEBUG else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    logger.info(
        f"Starting reverse gateway on :{config.GATEWAY_PORT}  "
        f"model={config.REVERSE_MODEL}  max_tool_rounds={config.MAX_TOOL_ROUNDS}"
    )
    logger.info(f"Reverse API: {config.REVERSE_BASE_URL}")
    logger.info(f"Workspace: {config.WORKSPACE.absolute()}")
    uvicorn.run(app, host="0.0.0.0", port=config.GATEWAY_PORT)
