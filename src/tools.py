"""Tool definitions and executors for the agentic gateway.

Tools are kept minimal to reduce token usage.
Each tool has: name, description, parameters, and an execute function.
"""

import os
import subprocess
import asyncio
from typing import Any, Callable, Awaitable

# ── Tool definitions (for prompt injection) ───────────────────────────────────

TOOL_DEFS = [
    {
        "name": "read",
        "description": "Read file contents. Returns line-count and content.",
        "parameters": {
            "path": {"type": "string", "description": "Absolute file path"},
            "offset": {"type": "number", "description": "Start line (0-based, optional)"},
            "limit": {"type": "number", "description": "Max lines to read (optional)"},
        },
        "required": ["path"],
    },
    {
        "name": "write",
        "description": "Write content to a file (creates or overwrites).",
        "parameters": {
            "path": {"type": "string", "description": "Absolute file path"},
            "content": {"type": "string", "description": "File content to write"},
        },
        "required": ["path", "content"],
    },
    {
        "name": "edit",
        "description": "Replace an exact string in a file with new content.",
        "parameters": {
            "path": {"type": "string", "description": "Absolute file path"},
            "old_string": {"type": "string", "description": "Exact text to find"},
            "new_string": {"type": "string", "description": "Replacement text"},
        },
        "required": ["path", "old_string", "new_string"],
    },
    {
        "name": "exec",
        "description": "Execute a shell command. Returns stdout and stderr.",
        "parameters": {
            "command": {"type": "string", "description": "Shell command to run"},
            "timeout": {"type": "number", "description": "Timeout in seconds (default 30)"},
        },
        "required": ["command"],
    },
    {
        "name": "web_search",
        "description": "Search the web or fetch content from a URL.",
        "parameters": {
            "url": {"type": "string", "description": "URL to fetch"},
        },
        "required": ["url"],
    },
    {
        "name": "web_fetch",
        "description": "Fetch raw text content from a URL.",
        "parameters": {
            "url": {"type": "string", "description": "URL to fetch"},
        },
        "required": ["url"],
    },
]

MAX_RESULT_CHARS = 10_000


def tools_to_prompt() -> str:
    """Serialize tool definitions into a compact prompt block."""
    lines = []
    for t in TOOL_DEFS:
        params = []
        for k, v in t["parameters"].items():
            req = " (required)" if k in t["required"] else ""
            params.append(f'  "{k}"{req}: {v["description"]}')
        params_str = ", ".join(
            f'"{k}"' for k in t["required"]
        )
        lines.append(f"- {t['name']}: {t['description']}")
        for p in params:
            lines.append(f"    {p}")

    tool_block = "\n".join(lines)

    return (
        "You have access to these tools:\n"
        f"{tool_block}\n\n"
        "To use a tool, output EXACTLY this JSON format in a fenced code block:\n"
        "```tool_json\n"
        '{"tool":"tool_name","parameters":{"param":"value"}}\n'
        "```\n\n"
        "Example: to read a file, return:\n"
        "```tool_json\n"
        '{"tool":"read","parameters":{"path":"/etc/hostname"}}\n'
        "```\n\n"
        "For plain text replies (no tool needed), just write normally.\n"
        "You may call only one tool per response."
    )


# ── Tool executors ────────────────────────────────────────────────────────────


def _truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return (
        text[:half]
        + f"\n\n... [{len(text) - limit} chars truncated] ...\n\n"
        + text[-half:]
    )


async def execute_read(path: str, offset: int = 0, limit: int = 0) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        total = len(lines)
        if offset:
            lines = lines[offset:]
        if limit:
            lines = lines[:limit]
        numbered = [f"{i + offset + 1:4d} | {line}" for i, line in enumerate(lines)]
        return _truncate(f"File: {path} ({total} lines)\n" + "".join(numbered))
    except FileNotFoundError:
        return f"Error: file not found: {path}"
    except Exception as e:
        return f"Error reading {path}: {e}"


async def execute_write(path: str, content: str) -> str:
    try:
        dir_name = os.path.dirname(path)
        if dir_name:
            os.makedirs(dir_name, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Written {len(content)} chars to {path}"
    except Exception as e:
        return f"Error writing {path}: {e}"


async def execute_edit(path: str, old_string: str, new_string: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        if old_string not in content:
            return f"Error: old_string not found in {path}"
        count = content.count(old_string)
        new_content = content.replace(old_string, new_string, 1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_content)
        msg = f"Replaced in {path}"
        if count > 1:
            msg += f" (warning: {count} occurrences found, replaced first only)"
        return msg
    except Exception as e:
        return f"Error editing {path}: {e}"


async def execute_exec(command: str, timeout: int = 30) -> str:
    try:
        is_windows = os.name == "nt"
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            shell=True,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        out = stdout.decode(errors="replace").strip()
        err = stderr.decode(errors="replace").strip()
        parts = []
        if out:
            parts.append(f"stdout:\n{out}")
        if err:
            parts.append(f"stderr:\n{err}")
        if proc.returncode != 0:
            parts.append(f"exit code: {proc.returncode}")
        result = "\n".join(parts) or "(no output)"
        return _truncate(result)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return f"Error: command timed out after {timeout}s"
    except Exception as e:
        return f"Error executing command: {e}"


async def execute_web_fetch(url: str) -> str:
    try:
        import httpx

        async with httpx.AsyncClient(
            timeout=15, follow_redirects=True, verify=False
        ) as client:
            resp = await client.get(
                url, headers={"User-Agent": "Mozilla/5.0 (compatible; Gateway/1.0)"}
            )
            text = resp.text
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type:
                return _truncate(text)
            from html.parser import HTMLParser

            class TextExtractor(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.parts: list[str] = []
                    self._skip = False

                def handle_starttag(self, tag, attrs):
                    if tag in ("script", "style", "noscript"):
                        self._skip = True

                def handle_endtag(self, tag):
                    if tag in ("script", "style", "noscript"):
                        self._skip = False
                    if tag in ("p", "div", "br", "li", "h1", "h2", "h3", "h4"):
                        self.parts.append("\n")

                def handle_data(self, data):
                    if not self._skip:
                        self.parts.append(data)

            extractor = TextExtractor()
            extractor.feed(text)
            cleaned = " ".join(extractor.parts)
            cleaned = "\n".join(line.strip() for line in cleaned.splitlines() if line.strip())
            return _truncate(cleaned) if cleaned else "(empty page)"
    except Exception as e:
        return f"Error fetching {url}: {e}"


# ── Registry ──────────────────────────────────────────────────────────────────

ToolExecutor = Callable[..., Awaitable[str]]

EXECUTORS: dict[str, ToolExecutor] = {
    "read": lambda **kw: execute_read(kw["path"], kw.get("offset", 0), kw.get("limit", 0)),
    "write": lambda **kw: execute_write(kw["path"], kw["content"]),
    "edit": lambda **kw: execute_edit(kw["path"], kw["old_string"], kw["new_string"]),
    "exec": lambda **kw: execute_exec(kw["command"], kw.get("timeout", 30)),
    "web_search": lambda **kw: execute_web_fetch(kw["url"]),
    "web_fetch": lambda **kw: execute_web_fetch(kw["url"]),
}


async def execute_tool(name: str, arguments: dict) -> str:
    executor = EXECUTORS.get(name)
    if not executor:
        return f"Error: unknown tool '{name}'"
    try:
        return await executor(**arguments)
    except KeyError as e:
        return f"Error: missing required parameter {e} for tool '{name}'"
    except Exception as e:
        return f"Error executing tool '{name}': {e}"
