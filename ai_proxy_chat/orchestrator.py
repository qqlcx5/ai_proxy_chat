"""Orchestrator —— 负责 agent 与工具之间的循环调度。"""

from __future__ import annotations

from .agent import agent
from .tools import TOOLS

MAX_ITERATIONS = 8


async def run(user_prompt: str) -> str | None:
    history: list = []
    prompt = user_prompt

    for _ in range(MAX_ITERATIONS):
        result = await agent.run(prompt, message_history=history)
        plan = result.data
        history = result.new_messages()

        if plan.kind == "final":
            return plan.answer

        tool = TOOLS.get(plan.tool_call.name)
        if tool is None:
            prompt = f"工具不存在：{plan.tool_call.name}。请重新选择可用工具。"
            continue

        tool_result = await tool.fn(**plan.tool_call.arguments)

        prompt = (
            f"工具 `{plan.tool_call.name}` 的结果如下：\n"
            f"{tool_result}\n"
            f"请基于这个结果继续规划，或者直接给出最终答案。"
        )

    raise RuntimeError("超过最大循环次数")