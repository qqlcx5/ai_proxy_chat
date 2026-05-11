可以，而且我建议你先走 **“PydanticAI 负责结构化输出 + 你自己执行工具”** 这条路，而不是一上来硬拼原生 tool calling。

原因很简单：

- PydanticAI 的 **工具调用** 默认是让模型直接发起 tool call 的，适合原生支持工具的模型。
- 你的逆向 API 如果只是**纯文本输出**，更稳的方式是用 **`PromptedOutput` + Pydantic 校验 + `ModelRetry`**，让模型先输出一个严格的“计划对象”，然后由你自己的 orchestrator 真正执行工具。

官方文档里对这些能力是支持的：
- [Agents](https://ai.pydantic.dev/agent/)
- [Output](https://ai.pydantic.dev/output/)
- [Message history](https://ai.pydantic.dev/message-history/)
- [Output validators](https://ai.pydantic.dev/output/)
- [ModelRetry](https://ai.pydantic.dev/api/exceptions/)
- [Function tools](https://ai.pydantic.dev/tools/)

**推荐实现方式**

1. 定义一个严格的计划 schema
2. 让模型每轮只输出 `tool_call` 或 `final`
3. 用 Pydantic 校验这个输出
4. 校验不过就 `ModelRetry`
5. 你的 Python 代码执行工具
6. 把工具结果塞回 `message_history`
7. 循环直到 `final`

---

## 最小可用结构

### 1) 安装

```bash
pip install pydantic-ai
```

如果你后面要做更完整的 HTTP 重试，可以再加：

```bash
pip install "pydantic-ai-slim[retries]"
```

---

### 2) 定义计划 schema

```python
from typing import Literal
from pydantic import BaseModel, Field

class ToolCall(BaseModel):
    name: str = Field(description="Tool name")
    arguments: dict = Field(description="JSON arguments for the tool")

class Plan(BaseModel):
    kind: Literal["tool_call", "final"]
    tool_call: ToolCall | None = None
    answer: str | None = None
```

---

### 3) 定义 agent，用 `PromptedOutput` 做结构化输出

```python
from pydantic_ai import Agent, PromptedOutput, RunContext, ModelRetry

agent = Agent(
    "openai:gpt-5.2",  # 如果你是 OpenAI-compatible 代理就换成你的 provider/model
    output_type=PromptedOutput(
        Plan,
        name="agent_plan",
        description="Return either a tool call plan or the final answer.",
    ),
    instructions="""
你是一个规划器。
你必须只输出符合 schema 的 JSON 风格结构。
如果需要外部信息，输出 kind=tool_call。
如果已经足够回答，输出 kind=final。
不要输出 Markdown，不要输出解释文字。
""",
)
```

如果你的逆向 API 不是 OpenAI-compatible，可以先把它包一层本地适配；如果你只是先试 PydanticAI 的“重校验”能力，这种写法最容易验证思路。

---

### 4) 加一个输出校验器

```python
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
```

这一步就是你说的“重校验”：
- Pydantic 先做类型和 schema 校验
- 你再做业务约束校验
- 不通过就让模型重试

---

### 5) orchestrator 自己执行工具

```python
async def search(query: str):
    return {"results": [f"fake result for {query}"]}

TOOLS = {
    "search": search,
}
```

---

### 6) 运行循环

```python
async def run_agent(user_prompt: str):
    history = []
    prompt = user_prompt

    for _ in range(8):
        result = await agent.run(prompt, message_history=history)
        plan: Plan = result.output
        history = result.new_messages()

        if plan.kind == "final":
            return plan.answer

        tool = TOOLS.get(plan.tool_call.name)
        if tool is None:
            prompt = f"工具不存在：{plan.tool_call.name}。请重新选择可用工具。"
            continue

        tool_result = await tool(**plan.tool_call.arguments)

        prompt = (
            f"工具 `{plan.tool_call.name}` 的结果如下：\n"
            f"{tool_result}\n"
            f"请基于这个结果继续规划，或者直接给出最终答案。"
        )

    raise RuntimeError("超过最大循环次数")
```

---

## 这套方案的好处

- **模型只负责生成计划**
- **工具执行完全由你掌控**
- **schema 和业务规则都能强校验**
- **后面换模型很容易**
- **逆向 API 不支持 function calling 也不怕**

---

## 如果你以后想升级成“真正的工具调用”

那就有两条路：

1. **把逆向 API 包成 OpenAI-compatible 接口**
   - 然后用 PydanticAI 的 `OpenAIChatModel` + 自定义 `base_url`
   - 官方文档明确支持这类 OpenAI-compatible provider
   - 参考：[OpenAI compatible providers](https://ai.pydantic.dev/models/overview/) 和 [OpenAI model docs](https://ai.pydantic.dev/models/openai/)

2. **自己实现 custom model**
   - 这个更重
   - 适合你真的要把它做成一个长期项目
   - 文档里也说明了：如果不是 OpenAI-compatible，就需要自己 subclass `Model`
   - 参考：[Model providers overview](https://ai.pydantic.dev/models/overview/)

---

## 我对你这个场景的建议

如果你现在目标是“先跑起来”，我建议：

1. **先用 `PromptedOutput + output_validator + 自己的 orchestrator`**
2. **等流程稳定后，再考虑把逆向 API 包成 OpenAI-compatible**
3. **最后才考虑 custom model**

这样风险最小，迭代也最快。

如果你愿意，我下一条可以直接给你一份：
1. `完整可运行的 Python 文件`
2. `一个支持多个工具的目录结构`
3. `把逆向 API 包成 OpenAI-compatible 的 shim 模板`

你回一个编号，我就直接往下写。
