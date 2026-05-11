"""AI API 智能路由代理"""

from typing import Literal

from pydantic import BaseModel, Field


class ToolCall(BaseModel):
    name: str = Field(description="Tool name")
    arguments: dict = Field(description="JSON arguments for the tool")


class Plan(BaseModel):
    kind: Literal["tool_call", "final"]
    tool_call: ToolCall | None = None
    answer: str | None = None