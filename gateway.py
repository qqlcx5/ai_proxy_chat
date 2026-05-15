"""Protocol-conversion gateway: Anthropic ↔ OpenAI-compatible (via PydanticAI).

PydanticAI handles the API call; we handle output parsing ourselves
because the reverse API returns plain text, not structured JSON.
"""

import os
import re
import uuid
import json
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    UserPromptPart,
    TextPart,
)
from dotenv import load_dotenv

load_dotenv()

REVERSE_BASE_URL = os.environ["REVERSE_API_URL"].removesuffix("/chat/completions")
REVERSE_API_KEY = os.environ["REVERSE_API_KEY"]
REVERSE_MODEL = os.getenv("REVERSE_API_MODEL", "claude-sonnet-4-6")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8000"))
DEBUG = os.getenv("DEBUG_MODE", "false").lower() == "true"

app = FastAPI()

# ── Output schema ──────────────────────────────────────────────────────────────


class ToolCallOutput(BaseModel):
    kind: Literal["tool_call"] = "tool_call"
    name: str
    arguments: dict = Field(default_factory=dict)


class TextOutput(BaseModel):
    kind: Literal["text"] = "text"
    text: str


# ── Helpers ────────────────────────────────────────────────────────────────────

# Regex for extracting tool calls from model output.
# Supports both XML format (<tool_call_request>...</tool_call_request>)
# and JSON format ({"kind":"tool_call",...}).
XML_RE = re.compile(
    r"<tool_call_request>\s*<name>([^<]+)</name>\s*<arguments>([^<]*)</arguments>\s*</tool_call_request>",
    re.DOTALL,
)
JSON_RE = re.compile(
    r'\{\s*"kind"\s*:\s*"tool_call"\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}',
    re.DOTALL,
)


def _tools_to_system(tools: list, base_system: str) -> str:
    if not tools:
        return base_system

    lines = []
    for t in tools:
        name = t.get("name", "")
        desc = t.get("description", "")
        schema = t.get("input_schema", {})
        props = schema.get("properties", {})
        req = set(schema.get("required", []))
        lines.append(f"- {name}: {desc}")
        for k, v in props.items():
            r = " (required)" if k in req else ""
            lines.append(f"    {k}{r}: {v.get('description', v.get('type', ''))}")

    tool_block = "\n".join(lines)
    injection = (
        "You have access to these tools:\n"
        f"{tool_block}\n\n"
        "When you need to call a tool, you MUST output EXACTLY this XML format "
        "and nothing else:\n"
        "<tool_call_request>\n"
        "  <name>tool_name_here</name>\n"
        '  <arguments>{"param": "value"}</arguments>\n'
        "</tool_call_request>\n\n"
        "When you want to reply with plain text (no tool call), just write normally.\n"
        "You may ONLY call one tool per response."
    )
    return f"{base_system}\n\n{injection}" if base_system else injection


def _parse_output(raw: str) -> ToolCallOutput | TextOutput:
    # Try XML format first
    m = XML_RE.search(raw)
    if m:
        name = m.group(1).strip()
        try:
            args = json.loads(m.group(2).strip())
        except json.JSONDecodeError:
            args = {}
        return ToolCallOutput(name=name, arguments=args)

    # Try JSON format
    m = JSON_RE.search(raw)
    if m:
        name = m.group(1).strip()
        try:
            args = json.loads(m.group(2).strip())
        except json.JSONDecodeError:
            args = {}
        return ToolCallOutput(name=name, arguments=args)

    return TextOutput(text=raw)


def _to_pydantic_history(
    messages: list,
) -> tuple[list[ModelMessage], str]:
    """Convert Anthropic messages to PydanticAI history.

    All tool-related content is flattened to plain text because the
    reverse API doesn't support native tool calls.
    """
    history: list[ModelMessage] = []
    tool_id_to_name: dict[str, str] = {}

    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]

        text_chunks: list[str] = []

        for p in content:
            if p["type"] == "text" and p.get("text"):
                text_chunks.append(p["text"])
            elif p["type"] == "tool_use":
                tid = p.get("id", str(uuid.uuid4()))
                name = p.get("name", "")
                tool_id_to_name[tid] = name
                text_chunks.append(
                    f"<tool_call_request>\n  <name>{name}</name>\n  "
                    f"<arguments>{json.dumps(p.get('input', {}), ensure_ascii=False)}</arguments>\n"
                    f"</tool_call_request>"
                )
            elif p["type"] == "tool_result":
                tid = p.get("tool_use_id", "")
                name = tool_id_to_name.get(tid, "tool")
                res = p.get("content", "")
                if isinstance(res, list):
                    res = "\n".join(
                        x.get("text", "") for x in res if x.get("type") == "text"
                    )
                text_chunks.append(f"[Tool {name} result]:\n{res}")

        combined = "\n".join(text_chunks)
        if not combined:
            continue

        if role == "user":
            history.append(ModelRequest(parts=[UserPromptPart(content=combined)]))
        elif role == "assistant":
            history.append(ModelResponse(parts=[TextPart(content=combined)]))

    # Extract last user prompt
    if history and isinstance(history[-1], ModelRequest):
        last = history.pop()
        texts = [p.content for p in last.parts if isinstance(p, UserPromptPart)]
        prompt = "\n".join(texts)
        return history, prompt or "Continue based on the tool results above."

    return history, ""


def _to_anthropic_response(output: ToolCallOutput | TextOutput, model: str) -> dict:
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    if isinstance(output, ToolCallOutput):
        return {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [
                {
                    "type": "tool_use",
                    "id": f"toolu_{uuid.uuid4().hex[:24]}",
                    "name": output.name,
                    "input": output.arguments,
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
        "content": [{"type": "text", "text": output.text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


# ── Route ──────────────────────────────────────────────────────────────────────


@app.post("/v1/messages")
async def handle_messages(request: Request):
    body = await request.json()
    tools = body.get("tools", [])
    msgs = body.get("messages", [])
    system = body.get("system", "") or ""
    model_id = body.get("model", REVERSE_MODEL)

    if DEBUG:
        print(f"[DEBUG] tools={[t['name'] for t in tools]}  msgs={len(msgs)}")

    system_prompt = _tools_to_system(
        tools, system if isinstance(system, str) else ""
    )
    history, last_prompt = _to_pydantic_history(msgs)

    if not last_prompt:
        last_prompt = "Continue."

    provider = OpenAIProvider(
        base_url=REVERSE_BASE_URL, api_key=REVERSE_API_KEY
    )
    model = OpenAIChatModel(REVERSE_MODEL, provider=provider)
    # output_type=str — we parse the raw text ourselves
    agent = Agent(model, output_type=str, system_prompt=system_prompt)

    result = await agent.run(last_prompt, message_history=history)
    raw = result.output

    if DEBUG:
        print(f"[DEBUG] raw={raw[:200]!r}")

    output = _parse_output(raw)
    return JSONResponse(_to_anthropic_response(output, model_id))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=GATEWAY_PORT)
