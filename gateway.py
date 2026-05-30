"""Protocol-conversion gateway: Anthropic ↔ OpenAI-compatible (via PydanticAI).

协议转换网关：将 Anthropic Messages API 兼容请求转换为 OpenAI 格式，
并通过逆向 API（纯文本模型）实现完整的工具调用能力。

核心设计：
  - 逆向 API 按纯文本对话模式处理，不依赖原生 tool calling
  - Gateway 端负责：prompt 注入 → 解析工具调用 → 执行工具 → 反馈结果 → 循环
  - 类似 Claude Code 的 agentic loop 模式

增强功能：
  1. Agentic loop — tool call → 执行 → 反馈给模型 → 循环（最多 MAX_TOOL_ROUNDS 轮）
  2. 健壮解析器 — 支持 fenced JSON / bare JSON / XML / legacy XML / fuzzy repair
  3. 完整工具集 — read, write, edit, exec, web_search, web_fetch
  4. Example-based prompt injection — 用示例教会模型输出正确格式
  5. 关键词启发 — 仅在用户消息涉及工具相关意图时注入工具提示

移植自 openclaw-zero-token TypeScript 实现。
"""

import asyncio
import os
import re
import uuid
import json
import logging
import urllib.request
import urllib.parse
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
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

logger = logging.getLogger("gateway")

# ── 配置区 ─────────────────────────────────────────────────────
# 所有可通过环境变量覆盖的配置项，集中在此管理
# REVERSE_BASE_URL: 逆向 API 的基础地址（不含 /chat/completions 后缀）
# REVERSE_API_KEY:  逆向 API 密钥
# REVERSE_MODEL:    模型名称，默认 gpt-5.2
# MAX_TOOL_ROUNDS:  agentic loop 最大轮数，防止无限循环
# EXEC_TIMEOUT:     命令执行超时（秒）
# WORKSPACE:        工具执行的工作目录

REVERSE_BASE_URL = os.environ["REVERSE_API_URL"].removesuffix("/chat/completions")
REVERSE_API_KEY = os.environ["REVERSE_API_KEY"]
REVERSE_MODEL = os.getenv("REVERSE_API_MODEL", "gpt-5.2")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8000"))
DEBUG = os.getenv("DEBUG_MODE", "false").lower() == "true"
MAX_TOOL_ROUNDS = int(os.getenv("MAX_TOOL_ROUNDS", "5"))
EXEC_TIMEOUT = int(os.getenv("EXEC_TIMEOUT", "30"))
WORKSPACE = Path(os.getenv("WORKSPACE", str(Path.cwd())))

app = FastAPI()

# ── Tool call parser (ported from openclaw) ────────────────────────────────

# 1. Fenced: ```tool_json\n{"tool":"...","parameters":{...}}\n```
_FENCED_RE = re.compile(r"```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```")

# 2. Bare JSON: {"tool":"...","parameters":{...}}
_BARE_RE = re.compile(
    r'\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}'
)

# 3. XML: <tool_call>{"name":"...","arguments":{...}}</tool_call>
_XML_RE = re.compile(r"<tool_call[^>]*>([\s\S]*?)</tool_call>")

# 4. Legacy XML: <tool_call_request>...</tool_call_request>
_LEGACY_XML_RE = re.compile(
    r"<tool_call_request>\s*<name>([^<]+)</name>\s*<arguments>([^<]*)</arguments>\s*</tool_call_request>",
    re.DOTALL,
)


def _parse_tool_json(raw: str) -> dict | None:
    """Parse tool JSON with auto-repair for unbalanced braces."""
    try:
        cleaned = raw.strip()
        # Auto-repair: if JSON has unbalanced braces, append }
        opens = cleaned.count("{")
        closes = cleaned.count("}")
        if opens > closes:
            cleaned += "}" * (opens - closes)
        obj = json.loads(cleaned)

        # ComfyUI format: {"tool":"name","parameters":{...}}
        if obj.get("tool") and isinstance(obj["tool"], str):
            return {"name": obj["tool"], "arguments": obj.get("parameters", {})}

        # OpenAI format: {"name":"...","arguments":{...}}
        if obj.get("name") and isinstance(obj["name"], str):
            return {"name": obj["name"], "arguments": obj.get("arguments", {})}

        return None
    except json.JSONDecodeError:
        return None


def extract_tool_call(text: str) -> dict | None:
    """Extract tool call from text. Returns {"name": str, "arguments": dict} or None.

    Supports (in priority order):
    1. Fenced code block: ```tool_json ... ```
    2. Bare JSON with "tool"/"parameters" keys
    3. XML <tool_call> tags
    4. Legacy <tool_call_request> XML format
    5. Fuzzy repair for truncated JSON
    """
    # 1. Fenced format
    m = _FENCED_RE.search(text)
    if m:
        result = _parse_tool_json(m.group(1))
        if result:
            return result

    # 2. Bare JSON
    m = _BARE_RE.search(text)
    if m:
        try:
            arguments = json.loads(m.group(2))
            return {"name": m.group(1), "arguments": arguments}
        except json.JSONDecodeError:
            pass

    # 3. XML tool_call
    m = _XML_RE.search(text)
    if m:
        result = _parse_tool_json(m.group(1))
        if result:
            return result

    # 4. Legacy XML format
    m = _LEGACY_XML_RE.search(text)
    if m:
        name = m.group(1).strip()
        try:
            args = json.loads(m.group(2).strip())
        except json.JSONDecodeError:
            args = {}
        return {"name": name, "arguments": args}

    # 5. Fuzzy repair: truncated JSON from SSE
    m = re.search(
        r'\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}', text
    )
    if m:
        repaired = f'{{"tool":"{m.group(1)}","parameters":{{{m.group(2)}}}}}'
        result = _parse_tool_json(repaired)
        if result:
            return result

    return None


# ── Tool definitions + prompt ───────────────────────────────────────────────

CORE_TOOLS = [
    {"name": "read", "description": "Read file", "parameters": {"path": "string"}},
    {
        "name": "write",
        "description": "Write file",
        "parameters": {"path": "string", "content": "string"},
    },
    {
        "name": "edit",
        "description": "Edit file (find and replace)",
        "parameters": {"path": "string", "old": "string", "new": "string"},
    },
    {"name": "exec", "description": "Run shell command", "parameters": {"command": "string"}},
    {
        "name": "web_fetch",
        "description": "Fetch URL content",
        "parameters": {"url": "string"},
    },
    {
        "name": "web_search",
        "description": "Search the web",
        "parameters": {"query": "string"},
    },
]

_TOOL_DEFS_JSON = json.dumps(CORE_TOOLS, ensure_ascii=False)

_TOOL_EXAMPLE = (
    "Example: to read a file named test.txt, return:\n"
    "```tool_json\n"
    '{"tool":"read","parameters":{"path":"test.txt"}}\n'
    "```\n"
    "(read is a real tool, this is just a format example)"
)

_TOOL_PROMPT = f"""Tools: {_TOOL_DEFS_JSON}

{_TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.
"""

# Tool-related keywords for selective injection (en + zh)
_TOOL_KEYWORDS = [
    "file", "read", "write", "edit", "exec", "run", "command", "shell",
    "search", "fetch", "url", "http", "download", "install", "update",
    "文件", "读取", "写入", "编辑", "执行", "运行", "命令", "终端",
    "搜索", "查找", "查询", "抓取", "网页", "下载", "安装", "更新",
    "帮我", "查看", "看看", "检查",
]


def _needs_tool_injection(message: str) -> bool:
    lower = message.lower()
    return any(kw in lower for kw in _TOOL_KEYWORDS)


def _build_system_prompt(tools: list, base_system: str) -> str:
    """Build system prompt with tool instructions injected."""
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
        f"You have access to these tools:\n{tool_block}\n\n"
        "When you need to call a tool, you MUST output EXACTLY this format "
        "and nothing else:\n"
        "```tool_json\n"
        '{"tool":"tool_name_here","parameters":{"param":"value"}}\n'
        "```\n\n"
        "When you want to reply with plain text (no tool call), just write normally.\n"
        "You may ONLY call one tool per response."
    )
    return f"{base_system}\n\n{injection}" if base_system else injection


# ── Tool execution ──────────────────────────────────────────────────────────


def _exec_read(path: str) -> str:
    # Support both absolute and relative paths
    p = Path(path)
    if not p.is_absolute():
        p = WORKSPACE / path

    if not p.exists():
        return f"Error: file not found: {path}"
    if not p.is_file():
        return f"Error: not a file: {path}"
    try:
        content = p.read_text(encoding="utf-8")
        if len(content) > 50_000:
            content = content[:50_000] + "\n... (truncated)"
        return content
    except Exception as e:
        return f"Error reading {path}: {e}"


def _exec_write(path: str, content: str) -> str:
    # Support both absolute and relative paths
    p = Path(path)
    if not p.is_absolute():
        p = WORKSPACE / path

    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"OK: wrote {len(content)} bytes to {path}"
    except Exception as e:
        return f"Error writing {path}: {e}"


def _exec_edit(path: str, old: str, new: str) -> str:
    # Support both absolute and relative paths
    p = Path(path)
    if not p.is_absolute():
        p = WORKSPACE / path

    if not p.exists():
        return f"Error: file not found: {path}"
    try:
        content = p.read_text(encoding="utf-8")
        if old not in content:
            return f"Error: old string not found in {path}"
        count = content.count(old)
        content = content.replace(old, new)
        p.write_text(content, encoding="utf-8")
        return f"OK: replaced {count} occurrence(s) in {path}"
    except Exception as e:
        return f"Error editing {path}: {e}"


async def _exec_command(command: str) -> str:
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(WORKSPACE),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=EXEC_TIMEOUT
        )
        output = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        result = ""
        if output:
            result += output
        if err:
            result += ("\n" if result else "") + err
        if proc.returncode != 0:
            result += f"\n(exit code: {proc.returncode})"
        if len(result) > 50_000:
            result = result[:50_000] + "\n... (truncated)"
        return result or "(no output)"
    except asyncio.TimeoutError:
        return f"Error: command timed out after {EXEC_TIMEOUT}s"
    except Exception as e:
        return f"Error executing command: {e}"


def _exec_web_fetch(url: str) -> str:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read(200_000).decode("utf-8", errors="replace")
            if len(data) > 50_000:
                data = data[:50_000] + "\n... (truncated)"
            return data
    except Exception as e:
        return f"Error fetching {url}: {e}"


def _exec_web_search(query: str) -> str:
    """Web search via DuckDuckGo lite (no API key needed)."""
    try:
        q = urllib.parse.quote(query)
        url = f"https://lite.duckduckgo.com/lite/?q={q}"
        req = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read(100_000).decode("utf-8", errors="replace")
        # Extract snippets from DuckDuckGo lite HTML
        results = []
        for m in re.finditer(
            r'class="result-snippet">(.*?)</td>', html, re.DOTALL
        ):
            snippet = re.sub(r"<[^>]+>", "", m.group(1)).strip()
            if snippet:
                results.append(snippet)
        if not results:
            # Fallback: extract all text
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text).strip()
            return text[:5000] if text else "No search results found."
        return "\n\n".join(results[:5])
    except Exception as e:
        return f"Error searching: {e}"


async def execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool by name and return the result as a string."""
    logger.info(f"  Executing tool: {name} with args: {arguments}")
    try:
        if name == "read":
            path = arguments.get("path", "")
            logger.debug(f"    Reading file: {path}")
            result = _exec_read(path)
            logger.debug(f"    Read result: {result[:200]}")
            return result
        elif name == "write":
            path = arguments.get("path", "")
            content = arguments.get("content", "")
            logger.debug(f"    Writing to file: {path} ({len(content)} bytes)")
            return _exec_write(path, content)
        elif name == "edit":
            path = arguments.get("path", "")
            logger.debug(f"    Editing file: {path}")
            return _exec_edit(
                path,
                arguments.get("old", ""),
                arguments.get("new", ""),
            )
        elif name == "exec":
            cmd = arguments.get("command", "")
            logger.debug(f"    Executing command: {cmd}")
            return await _exec_command(cmd)
        elif name == "web_fetch":
            url = arguments.get("url", "")
            logger.debug(f"    Fetching URL: {url}")
            return _exec_web_fetch(url)
        elif name == "web_search":
            query = arguments.get("query", "")
            logger.debug(f"    Searching: {query}")
            return _exec_web_search(query)
        else:
            return f"Error: unknown tool '{name}'"
    except Exception as e:
        logger.error(f"  Tool execution error: {e}", exc_info=True)
        return f"Error executing tool '{name}': {e}"


# ── Response conversion ─────────────────────────────────────────────────────


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


# ── History conversion ──────────────────────────────────────────────────────


def _to_pydantic_history(
    messages: list,
) -> tuple[list[ModelMessage], str]:
    """Convert Anthropic messages to PydanticAI history.

    Flattens tool-related content to plain text because the
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


# ── Agentic loop ────────────────────────────────────────────────────────────


async def _call_model(
    prompt: str,
    history: list[ModelMessage],
    system_prompt: str,
) -> str:
    """Call the reverse API via PydanticAI and return raw text."""
    provider = OpenAIProvider(base_url=REVERSE_BASE_URL, api_key=REVERSE_API_KEY)
    model = OpenAIChatModel(REVERSE_MODEL, provider=provider)
    agent = Agent(model, output_type=str, system_prompt=system_prompt)
    result = await agent.run(prompt, message_history=history)
    return result.output


async def _agentic_loop(
    prompt: str,
    history: list[ModelMessage],
    system_prompt: str,
    model_id: str,
) -> tuple[dict | None, str]:
    """Run the agentic loop: call model, check for tool calls, execute, repeat.

    Returns (tool_call_for_response, final_text).
    If the model calls a tool, executes it, feeds back, and loops.
    The returned tool_call is the LAST one (for the Anthropic response).
    """
    current_prompt = prompt
    current_history = list(history)
    last_tool_call = None
    accumulated_text = ""

    for round_num in range(MAX_TOOL_ROUNDS):
        logger.debug("  agentic loop round %d/%d", round_num + 1, MAX_TOOL_ROUNDS)

        raw = await _call_model(current_prompt, current_history, system_prompt)
        logger.debug("    raw (%d chars): %.200s", len(raw), raw)

        tool_call = extract_tool_call(raw)

        if tool_call is None:
            # No tool call — model is done
            return None, raw

        logger.info(
            "    tool_call: %s(%s)",
            tool_call["name"],
            json.dumps(tool_call["arguments"], ensure_ascii=False)[:200],
        )

        # Execute the tool
        result = await execute_tool(tool_call["name"], tool_call["arguments"])
        logger.debug("    tool result (%d chars): %.200s", len(result), result)

        # Feed result back as a user message
        feedback = (
            f"Tool {tool_call['name']} returned:\n{result}\n\n"
            "Please continue answering based on this result."
        )

        current_history.append(
            ModelResponse(parts=[TextPart(content=raw)])
        )
        current_history.append(
            ModelRequest(parts=[UserPromptPart(content=feedback)])
        )
        current_prompt = feedback
        last_tool_call = tool_call
        accumulated_text = raw

    # Hit max rounds — return whatever we have
    logger.warning("  agentic loop hit max rounds (%d)", MAX_TOOL_ROUNDS)
    return last_tool_call, accumulated_text or "Max tool rounds reached."


# ── Route ───────────────────────────────────────────────────────────────────


@app.post("/v1/messages")
async def handle_messages(request: Request):
    body = await request.json()
    tools = body.get("tools", [])
    msgs = body.get("messages", [])
    system = body.get("system", "") or ""
    model_id = body.get("model", REVERSE_MODEL)

    logger.info(
        ">>> request  model=%s  tools=%d  messages=%d",
        model_id,
        len(tools),
        len(msgs),
    )
    if tools:
        logger.debug("  tool names: %s", [t.get("name") for t in tools])

    system_prompt = _build_system_prompt(
        tools, system if isinstance(system, str) else ""
    )
    history, last_prompt = _to_pydantic_history(msgs)

    if not last_prompt:
        last_prompt = "Continue."

    # Check if we should inject the compact tool prompt into the user message
    # (for models that don't receive system messages well)
    if tools and _needs_tool_injection(last_prompt):
        last_prompt = _TOOL_PROMPT + last_prompt

    logger.debug(
        "  history turns=%d  last_prompt=%s",
        len(history),
        last_prompt[:120] + ("..." if len(last_prompt) > 120 else ""),
    )

    # Run the agentic loop
    tool_call, text = await _agentic_loop(
        last_prompt, history, system_prompt, model_id
    )

    if tool_call:
        logger.info(
            "<<< response tool_call  name=%s  args=%s",
            tool_call["name"],
            json.dumps(tool_call["arguments"], ensure_ascii=False)[:200],
        )
    else:
        preview = text[:120] + ("..." if len(text) > 120 else "")
        logger.info("<<< response text (%d chars): %s", len(text), preview)

    return JSONResponse(_to_anthropic_response(tool_call, text, model_id))


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(
        level=logging.DEBUG if DEBUG else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    logger.info(
        "Starting gateway on :%d  model=%s  max_tool_rounds=%d",
        GATEWAY_PORT,
        REVERSE_MODEL,
        MAX_TOOL_ROUNDS,
    )
    logger.info(f"Workspace: {WORKSPACE.absolute()}")
    logger.info(f"Tool execution timeout: {EXEC_TIMEOUT}s")
    uvicorn.run(app, host="0.0.0.0", port=GATEWAY_PORT)

