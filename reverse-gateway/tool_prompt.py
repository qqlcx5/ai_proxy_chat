"""Prompt injection for tool calling — ported from openclaw-zero-token.

Strategy: inject compact tool definitions + virtual tool example into the prompt
so models output tool calls as fenced JSON code blocks.
"""

import json

# ── Tool definitions (ultra-compact, ~350 chars total) ──────────────────────

CORE_TOOLS = [
    {"name": "read", "description": "Read file", "parameters": {"path": "string"}},
    {"name": "write", "description": "Write file", "parameters": {"path": "string", "content": "string"}},
    {"name": "edit", "description": "Edit file (find and replace)", "parameters": {"path": "string", "old": "string", "new": "string"}},
    {"name": "exec", "description": "Run shell command", "parameters": {"command": "string"}},
    {"name": "web_fetch", "description": "Fetch URL content", "parameters": {"url": "string"}},
    {"name": "web_search", "description": "Search the web", "parameters": {"query": "string"}},
]

_TOOL_DEFS_JSON = json.dumps(CORE_TOOLS, ensure_ascii=False)


# ── Prompt templates ────────────────────────────────────────────────────────
# Uses a virtual tool "plus_one" as format example (arXiv:2407.04997)

_EN_TEMPLATE = """You have access to these tools:
{tool_defs}

Example: to call a tool, reply ONLY with the tool_json block:
```tool_json
{{"tool":"plus_one","parameters":{{"number":"5"}}}}
```
(plus_one is a format example, not a real tool)

No tool needed? Answer directly. You may ONLY call one tool per response."""

_CN_TEMPLATE = """你可以使用以下工具：
{tool_defs}

示例：要调用工具，只回复 tool_json 代码块：
```tool_json
{{"tool":"plus_one","parameters":{{"number":"5"}}}}
```
(plus_one 是格式示例，不是真实工具)

不需要工具？直接回答。每次只能调用一个工具。"""

_EN_STRICT_TEMPLATE = """You have access to these tools:
{tool_defs}

Example: to call a tool, reply ONLY with the tool_json block:
```tool_json
{{"tool":"plus_one","parameters":{{"number":"5"}}}}
```
(plus_one is a format example, not a real tool)

No tool needed? Answer directly. You may ONLY call one tool per response.
No extra text. Output ONLY the tool_json block when calling a tool."""


def _get_tool_prompt(is_cn: bool = False, is_strict: bool = False) -> str:
    template = _CN_TEMPLATE if is_cn else (_EN_STRICT_TEMPLATE if is_strict else _EN_TEMPLATE)
    return template.format(tool_defs=_TOOL_DEFS_JSON)


# ── Keyword detection ───────────────────────────────────────────────────────
# Gate tool injection to reduce ban risk on web platforms

_TOOL_KEYWORDS = [
    # File operations
    "file", "文件", "read", "读取", "write", "写入", "edit", "编辑",
    "创建", "目录", "folder", "directory", "save", "保存", "open", "打开",
    # Command execution
    "command", "命令", "exec", "terminal", "shell", "执行", "运行",
    "bash", "cmd", "script", "脚本", "process", "进程",
    # Web operations
    "search", "搜索", "fetch", "抓取", "url", "http", "download", "下载",
    "网页", "web", "api", "request", "请求",
    # General
    "帮我", "help me", "查看", "check", "show", "find", "查找",
    "install", "安装", "update", "更新", "run", "test", "测试",
]


def needs_tool_injection(message: str) -> bool:
    """Check if message contains tool-related keywords."""
    lower = message.lower()
    return any(kw in lower for kw in _TOOL_KEYWORDS)


def build_system_prompt(
    system: str | None,
    tools: list[dict],
    is_cn: bool = False,
    is_strict: bool = False,
) -> str:
    """Build the full system prompt with tool instructions.

    Two injection strategies:
    1. If caller provides Anthropic-style tools → format them into the prompt
    2. If no caller tools → use our built-in CORE_TOOLS with the compact prompt
    """
    parts: list[str] = []

    if system:
        parts.append(system if isinstance(system, str) else "")

    if tools:
        # Caller provided tools — format them into a detailed prompt
        tool_lines: list[str] = []
        for t in tools:
            name = t.get("name", "")
            desc = t.get("description", "")
            schema = t.get("input_schema", {})
            props = schema.get("properties", {})
            req = set(schema.get("required", []))
            tool_lines.append(f"- {name}: {desc}")
            for k, v in props.items():
                r = " (required)" if k in req else ""
                tool_lines.append(f"    {k}{r}: {v.get('description', v.get('type', ''))}")

        tool_block = "\n".join(tool_lines)
        injection = (
            f"You have access to these tools:\n{tool_block}\n\n"
            "When you need to call a tool, you MUST output EXACTLY this format "
            "and nothing else:\n"
            "```tool_json\n"
            '{"tool":"tool_name_here","parameters":{"param":"value"}}\n'
            "```\n\n"
            "When you want to reply with plain text (no tool call), just write normally.\n"
            "You may ONLY call one tool per response."
        )
        parts.append(injection)
    else:
        # No caller tools — inject our built-in compact tool prompt
        parts.append(_get_tool_prompt(is_cn, is_strict))

    return "\n\n".join(parts)


def format_tool_result(tool_name: str, result: str) -> str:
    """Format a tool execution result for feeding back to the model."""
    return f"Tool {tool_name} returned:\n{result}\n\nPlease continue answering based on this result."
