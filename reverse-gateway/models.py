import uuid
from typing import Any

from pydantic import BaseModel, Field


# ── Request models (Anthropic Messages API) ─────────────────────────────────

class ContentBlock(BaseModel):
    type: str
    text: str | None = None
    id: str | None = None
    name: str | None = None
    input: dict[str, Any] | None = None
    tool_use_id: str | None = None
    content: str | list[dict[str, Any]] | None = None


class Message(BaseModel):
    role: str
    content: str | list[ContentBlock]


class ToolDef(BaseModel):
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class MessagesRequest(BaseModel):
    model: str = "gpt-5.2"
    messages: list[Message]
    system: str | list[dict[str, Any]] | None = None
    tools: list[ToolDef] = Field(default_factory=list)
    max_tokens: int = 8192
    stream: bool = False
    temperature: float | None = None


# ── Response models ─────────────────────────────────────────────────────────

class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class MessagesResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"msg_{uuid.uuid4().hex[:24]}")
    type: str = "message"
    role: str = "assistant"
    model: str = ""
    content: list[dict[str, Any]] = Field(default_factory=list)
    stop_reason: str | None = None
    stop_sequence: str | None = None
    usage: Usage = Field(default_factory=Usage)
