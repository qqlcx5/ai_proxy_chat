"""Tool executor — runs tools and returns results as strings.

6 tools: read, write, edit, exec, web_search, web_fetch
"""

import asyncio
import json
import logging
import re
import urllib.parse
import urllib.request
from pathlib import Path

import config

logger = logging.getLogger("gateway.tools")


def _exec_read(path: str) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = config.WORKSPACE / path

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
    p = Path(path)
    if not p.is_absolute():
        p = config.WORKSPACE / path

    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"OK: wrote {len(content)} bytes to {path}"
    except Exception as e:
        return f"Error writing {path}: {e}"


def _exec_edit(path: str, old: str, new: str) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = config.WORKSPACE / path

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
            cwd=str(config.WORKSPACE),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=config.EXEC_TIMEOUT
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
        return f"Error: command timed out after {config.EXEC_TIMEOUT}s"
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
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read(100_000).decode("utf-8", errors="replace")
        results = []
        for m in re.finditer(r'class="result-snippet">(.*?)</td>', html, re.DOTALL):
            snippet = re.sub(r"<[^>]+>", "", m.group(1)).strip()
            if snippet:
                results.append(snippet)
        if not results:
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text).strip()
            return text[:5000] if text else "No search results found."
        return "\n\n".join(results[:5])
    except Exception as e:
        return f"Error searching: {e}"


async def execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool by name and return the result as a string."""
    logger.info(f"  Executing tool: {name} with args: {json.dumps(arguments, ensure_ascii=False)[:200]}")
    try:
        if name == "read":
            return _exec_read(arguments.get("path", ""))
        elif name == "write":
            return _exec_write(arguments.get("path", ""), arguments.get("content", ""))
        elif name == "edit":
            return _exec_edit(
                arguments.get("path", ""),
                arguments.get("old", ""),
                arguments.get("new", ""),
            )
        elif name == "exec":
            return await _exec_command(arguments.get("command", ""))
        elif name == "web_fetch":
            return _exec_web_fetch(arguments.get("url", ""))
        elif name == "web_search":
            return _exec_web_search(arguments.get("query", ""))
        else:
            return f"Error: unknown tool '{name}'"
    except Exception as e:
        logger.error(f"  Tool execution error: {e}", exc_info=True)
        return f"Error executing tool '{name}': {e}"
