/**
 * Tool Call Parser — extracts tool calls from model text responses.
 *
 * Ported and enhanced from openclaw-zero-token/web-tool-parser.ts.
 *
 * Supports four formats (tried in order):
 * 1. Fenced:  ```tool_json\n{"tool":"...","parameters":{...}}\n```
 * 2. Bare JSON: {"tool":"...","parameters":{...}}
 * 3. XML wrapped: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 * 4. OpenAI style: {"name":"...","arguments":{...}}
 *
 * Includes robust repair for truncated/malformed JSON from streaming.
 */

import type { ParsedToolCall } from "../protocol/types.js";

// ─── Regex patterns ───────────────────────────────────────────────────

// Fenced code block (most reliable). Handles truncated blocks too.
const FENCED_REGEX = /```tool_json\s*\n?\s*([\s\S]*?)\n?\s*```/g;

// Bare JSON: {"tool":"name","parameters":{...}}  (may have trailing fields like "call_id":null)
const BARE_JSON_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*(?:,[\s\S]*?)?\}/g;

// XML wrapped: <tool_call>...</tool_call>
const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/g;

// OpenAI style: {"name":"...","arguments":{...}} or {"name":"...","arguments":"..."}
// The arguments value can be an object or a stringified JSON (with escaped quotes)
const OPENAI_STYLE_REGEX = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\}|"(?:[^"\\]|\\.)*")\s*\}/g;

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Extract all tool calls from text.
 * Returns empty array if none found.
 */
export function extractToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const seen = new Set<string>();

  // 1. Fenced format (can have multiple)
  for (const match of text.matchAll(FENCED_REGEX)) {
    const parsed = parseToolJson(match[1]);
    if (parsed && !seen.has(JSON.stringify(parsed))) {
      seen.add(JSON.stringify(parsed));
      calls.push(parsed);
    }
  }
  if (calls.length > 0) return calls;

  // 2. Bare JSON
  for (const match of text.matchAll(BARE_JSON_REGEX)) {
    try {
      const params = JSON.parse(match[2]);
      const call = { tool: match[1], parameters: params };
      if (!seen.has(JSON.stringify(call))) {
        seen.add(JSON.stringify(call));
        calls.push(call);
      }
    } catch {
      // Try repair
      const repaired = repairJson(match[2]);
      if (repaired) {
        const call = { tool: match[1], parameters: repaired };
        if (!seen.has(JSON.stringify(call))) {
          seen.add(JSON.stringify(call));
          calls.push(call);
        }
      }
    }
  }
  if (calls.length > 0) return calls;

  // 3. XML wrapped
  for (const match of text.matchAll(XML_TOOL_REGEX)) {
    const parsed = parseToolJson(match[1]);
    if (parsed && !seen.has(JSON.stringify(parsed))) {
      seen.add(JSON.stringify(parsed));
      calls.push(parsed);
    }
  }
  if (calls.length > 0) return calls;

  // 4. OpenAI style
  for (const match of text.matchAll(OPENAI_STYLE_REGEX)) {
    const name = match[1];
    let args: Record<string, unknown> = {};
    const argsRaw = match[2].trim();
    if (argsRaw.startsWith('"')) {
      // arguments is a stringified JSON
      try {
        args = JSON.parse(JSON.parse(argsRaw));
      } catch {
        try {
          args = JSON.parse(argsRaw.slice(1, -1));
        } catch {
          args = { _raw: argsRaw };
        }
      }
    } else {
      try {
        args = JSON.parse(argsRaw);
      } catch {
        const repaired = repairJson(argsRaw);
        if (repaired) args = repaired;
      }
    }
    const call = { tool: name, parameters: args };
    if (!seen.has(JSON.stringify(call))) {
      seen.add(JSON.stringify(call));
      calls.push(call);
    }
  }
  if (calls.length > 0) return calls;

  // 5. Fuzzy repair: truncated tool_call (SSE dropped closing braces)
  // Match {"tool":"name","parameters":{... even if closing braces are missing
  const fuzzyMatch = text.match(
    /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?)\s*$/,
  );
  if (fuzzyMatch) {
    // Rebuild with balanced braces and parse
    let inner = fuzzyMatch[2];
    // Balance inner braces
    const innerOpens = (inner.match(/\{/g) || []).length;
    const innerCloses = (inner.match(/\}/g) || []).length;
    inner += "}".repeat(Math.max(0, innerOpens - innerCloses));
    const repaired = `{"tool":"${fuzzyMatch[1]}","parameters":${inner}}`;
    const parsed = parseToolJson(repaired);
    if (parsed) return [parsed];
  }

  // 6. Fuzzy repair for OpenAI style: {"name":"...","arguments":{... (truncated)
  const fuzzyOai = text.match(
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?)\s*$/,
  );
  if (fuzzyOai) {
    let inner = fuzzyOai[2];
    const innerOpens = (inner.match(/\{/g) || []).length;
    const innerCloses = (inner.match(/\}/g) || []).length;
    inner += "}".repeat(Math.max(0, innerOpens - innerCloses));
    const repaired = `{"name":"${fuzzyOai[1]}","arguments":${inner}}`;
    const parsed = parseToolJson(repaired);
    if (parsed) return [parsed];
  }

  return [];
}

/**
 * Extract a single tool call (first one found).
 * Kept for backward compat with openclaw's extractToolCall.
 */
export function extractToolCall(text: string): ParsedToolCall | null {
  const calls = extractToolCalls(text);
  return calls.length > 0 ? calls[0] : null;
}

/**
 * Quick check: does text contain a tool call?
 */
export function hasToolCall(text: string): boolean {
  // Create fresh regexes without /g to avoid lastIndex issues
  const fenced = /```tool_json\s*\n?[\s\S]*?```/;
  const bareJson = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[\s\S]*?\}\s*\}/;
  const xml = /<tool_call[^>]*>[\s\S]*?<\/tool_call>/;
  const oaiStyle = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/;
  if (fenced.test(text) || bareJson.test(text) || xml.test(text) || oaiStyle.test(text)) {
    return true;
  }
  // Fuzzy: truncated tool call
  return /\{\s*"(?:tool|name)"\s*:\s*"[^"]+"/.test(text);
}

// ─── Internal helpers ─────────────────────────────────────────────────

function parseToolJson(raw: string): ParsedToolCall | null {
  try {
    let cleaned = raw.trim();
    // Auto-repair: balance braces
    const opens = (cleaned.match(/\{/g) || []).length;
    const closes = (cleaned.match(/\}/g) || []).length;
    if (opens > closes) {
      cleaned += "}".repeat(opens - closes);
    }
    const obj = JSON.parse(cleaned);

    // ComfyUI format: {"tool":"name","parameters":{...}}
    if (obj.tool && typeof obj.tool === "string") {
      return {
        tool: obj.tool,
        parameters: obj.parameters ?? {},
      };
    }

    // OpenAI format: {"name":"...","arguments":{...}}
    if (obj.name && typeof obj.name === "string") {
      let args = obj.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          // Keep as string
        }
      }
      return {
        tool: obj.name,
        parameters: args ?? {},
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to repair truncated/malformed JSON.
 * Returns parsed object or null.
 */
function repairJson(raw: string): Record<string, unknown> | null {
  let cleaned = raw.trim();

  // Balance braces
  const opens = (cleaned.match(/\{/g) || []).length;
  const closes = (cleaned.match(/\}/g) || []).length;
  if (opens > closes) {
    cleaned += "}".repeat(opens - closes);
  }

  // Balance brackets
  const openBrackets = (cleaned.match(/\[/g) || []).length;
  const closeBrackets = (cleaned.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    cleaned += "]".repeat(openBrackets - closeBrackets);
  }

  // Try appending closing quote if odd number of quotes
  const quoteCount = (cleaned.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    cleaned += '"';
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ─── Repair info (for logging) ────────────────────────────────────────

export interface ParseResult {
  calls: ParsedToolCall[];
  repairUsed: string | null;
}

/**
 * Parse with repair info for logging.
 */
export function parseWithRepairInfo(text: string): ParseResult {
  const calls = extractToolCalls(text);

  let repair: string | null = null;
  if (calls.length > 0) {
    // Detect what repair was needed
    if (text.includes('```tool_json')) {
      repair = null; // clean fenced
    } else if (text.includes('<tool_call>')) {
      repair = 'xml_format';
    } else {
      // Check if braces were balanced
      const openBraces = (text.match(/\{/g) || []).length;
      const closeBraces = (text.match(/\}/g) || []).length;
      if (openBraces > closeBraces) {
        repair = 'brace_balance';
      } else {
        repair = 'bare_json';
      }
    }
  }

  return { calls, repairUsed: repair };
}
