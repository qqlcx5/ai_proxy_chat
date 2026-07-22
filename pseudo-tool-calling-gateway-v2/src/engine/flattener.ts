import type { InternalRequest, NormalizedMessage } from "../protocol/types.js";

const TOOL_RESULT_TRUNCATE = 2000;
const KEEP_RECENT_TURNS = 3;

export interface FlatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function flattenContext(req: InternalRequest, injectedPrompt: string): FlatMessage[] {
  const out: FlatMessage[] = [];
  if (req.systemPrompt) out.push({ role: "system", content: req.systemPrompt });
  const recent = req.messages.slice(-KEEP_RECENT_TURNS * 2);
  const userMessage = buildUserMessage(recent, injectedPrompt);
  out.push({ role: "user", content: userMessage });
  return out;
}

function buildUserMessage(msgs: NormalizedMessage[], toolPrompt: string): string {
  const parts: string[] = [];
  if (toolPrompt) parts.push(toolPrompt);
  const transcript = msgs.map(renderMessage).filter(Boolean);
  if (transcript.length > 0) parts.push(`[conversation history]\n${transcript.join("\n")}`);
  return parts.join("\n\n");
}

function renderMessage(m: NormalizedMessage): string {
  switch (m.role) {
    case "user": return `[user] ${m.text}`;
    case "assistant": return `[assistant] ${m.text}`;
    case "tool_result": return `[tool ${m.toolName ?? "?"} returned] ${truncate(m.text)}`;
  }
}

function truncate(s: string): string {
  if (s.length <= TOOL_RESULT_TRUNCATE) return s;
  return `${s.slice(0, TOOL_RESULT_TRUNCATE)}\n...[truncated ${s.length}→${TOOL_RESULT_TRUNCATE}]`;
}
