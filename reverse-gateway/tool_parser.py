"""Tool call parser — ported from openclaw-zero-token.

Extracts tool calls from model text output. Supports 4 parsing strategies:
1. Fenced code block: ```tool_json ... ```
2. Bare JSON: {"tool":"...","parameters":{...}}
3. XML: <tool_call>...</tool_call>
4. Fuzzy repair: truncated JSON from SSE streams
"""

import json
import re

# 1. Fenced: ```tool_json\n{"tool":"...","parameters":{...}}\n```
_FENCED_RE = re.compile(r"```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```")

# 2. Bare JSON: {"tool":"...","parameters":{...}}
_BARE_RE = re.compile(
    r'\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}'
)

# 3. XML: <tool_call>...</tool_call>
_XML_RE = re.compile(r"<tool_call[^>]*>([\s\S]*?)</tool_call>")

# 4. Fuzzy: truncated JSON (missing closing brace)
_FUZZY_RE = re.compile(
    r'\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}'
)


def parse_tool_json(raw: str) -> dict | None:
    """Parse tool JSON with auto-repair for unbalanced braces.

    Supports two JSON schemas:
    - ComfyUI: {"tool":"...","parameters":{...}}
    - OpenAI:  {"name":"...","arguments":{...}}
    """
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


def has_tool_call(text: str) -> bool:
    """Quick check if text contains a tool call pattern."""
    return bool(
        _FENCED_RE.search(text)
        or _BARE_RE.search(text)
        or _XML_RE.search(text)
    )


def extract_tool_call(text: str) -> dict | None:
    """Extract tool call from text. Returns {"name": str, "arguments": dict} or None.

    Tries 4 strategies in priority order.
    """
    # 1. Fenced format
    m = _FENCED_RE.search(text)
    if m:
        result = parse_tool_json(m.group(1))
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
        result = parse_tool_json(m.group(1))
        if result:
            return result

    # 4. Fuzzy repair: truncated JSON from SSE
    m = _FUZZY_RE.search(text)
    if m:
        repaired = f'{{"tool":"{m.group(1)}","parameters":{{{m.group(2)}}}}}'
        result = parse_tool_json(repaired)
        if result:
            return result

    return None
