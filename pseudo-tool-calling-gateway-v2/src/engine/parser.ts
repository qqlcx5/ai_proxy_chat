import type { ParsedToolCall } from "../protocol/types.js";

const FENCED_REGEX = /```tool_json\s*\n?\s*([\s\S]*?)\n?\s*```/;
const BARE_JSON_REGEX = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/;
const OPENAI_BARE_REGEX = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/;
const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/;

export function extractToolCall(text: string): ParsedToolCall | null {
  const fenced = FENCED_REGEX.exec(text);
  if (fenced) {
    const r = parseToolJson(fenced[1]!);
    if (r) return r;
  }
  const bare = BARE_JSON_REGEX.exec(text);
  if (bare) {
    try {
      return { tool: bare[1]!, parameters: JSON.parse(bare[2]!) };
    } catch { /* fall */ }
  }
  const openai = OPENAI_BARE_REGEX.exec(text);
  if (openai) {
    try {
      return { tool: openai[1]!, parameters: JSON.parse(openai[2]!) };
    } catch { /* fall */ }
  }
  const xml = XML_TOOL_REGEX.exec(text);
  if (xml) {
    const r = parseToolJson(xml[1]!);
    if (r) return r;
  }
  const fuzzy = text.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}/);
  if (fuzzy) {
    const r = parseToolJson(`{"tool":"${fuzzy[1]}","parameters":{${fuzzy[2]}}}`);
    if (r) return r;
  }
  return null;
}

function parseToolJson(raw: string): ParsedToolCall | null {
  try {
    let cleaned = raw.trim();
    const opens = (cleaned.match(/\{/g) || []).length;
    const closes = (cleaned.match(/\}/g) || []).length;
    if (opens > closes) cleaned += "}".repeat(opens - closes);
    const obj = JSON.parse(cleaned);
    if (obj.tool && typeof obj.tool === "string") return { tool: obj.tool, parameters: obj.parameters ?? {} };
    if (obj.name && typeof obj.name === "string") return { tool: obj.name, parameters: obj.arguments ?? obj.parameters ?? {} };
    return null;
  } catch {
    return null;
  }
}
