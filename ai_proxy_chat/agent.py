"""Agent 定义和 orchestrator 循环。"""

from pydantic_ai import Agent, ModelRetry, RunContext

from .schema import Plan

agent = Agent(
    "openai:gpt-5.2",
    output_type=Plan,
    instructions="""\
你是一个规划器。
你必须只输出符合 schema 的 JSON 风格结构。
如果需要外部信息，输出 kind=tool_call。
如果已经足够回答，输出 kind=final。
不要输出 Markdown，不要输出解释文字。
""",
)


@agent.output_validator
def validate_plan(ctx: RunContext[None], output: Plan) -> Plan:
    if output.kind == "tool_call":
        if not output.tool_call:
            raise ModelRetry("kind=tool_call 时必须提供 tool_call。")
        if not output.tool_call.name:
            raise ModelRetry("tool_call.name 不能为空。")
        return output

    if output.kind == "final":
        if not output.answer:
            raise ModelRetry("kind=final 时必须提供 answer。")
        return output

    raise ModelRetry("输出格式不合法。")
