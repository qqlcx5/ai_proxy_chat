/**
 * Prompt Injector — converts IR.tools into a compact text prompt.
 *
 * Borrows from openclaw-zero-token/web-tool-prompt.ts but adapts for
 * arbitrary tools passed by upstream clients (pi, Claude Code, Codex).
 */

import type { InternalRequest, NormalizedTool } from "../protocol/types.js";

/**
 * Compress a tool definition to minimal text.
 * Target: ~80 chars per tool.
 *
 * {"name":"read","desc":"Read file","params":["path"]}
 */
function compressTool(tool: NormalizedTool): string {
  const params = tool.inputSchema.properties
    ? Object.keys(tool.inputSchema.properties)
    : [];
  return JSON.stringify({
    name: tool.name,
    desc: tool.description.slice(0, 60),
    params,
  });
}

/**
 * Build the tool injection prompt.
 * Uses a teaching example with a fake tool (plus_one) per arXiv:2407.04997.
 */
export function buildToolPrompt(tools: NormalizedTool[]): string {
  if (tools.length === 0) return "";

  const toolList = tools.map(compressTool).join(", ");
  const totalLen = 200 + tools.length * 80;

  return `# Tool Calling

You have these tools: ${toolList}

To call a tool, reply ONLY with a fenced block:
\`\`\`tool_json
{"tool":"<name>","parameters":{...}}
\`\`\`
Example (plus_one is NOT a real tool, just showing format):
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
If no tool is needed, answer directly without any code block.`;
}

/**
 * Build the flattened context message to send to the upstream API.
 *
 * 1. System prompt + tool prompt at the top
 * 2. Flatten messages (tool_use → text, tool_result → text, truncate long content)
 * 3. Keep recent N turns as-is, summarize older turns
 */
export function buildFlattenedPrompt(
  req: InternalRequest,
  options: { keepRecentTurns: number; toolResultTruncate: number },
): { system: string; userMessage: string } {
  const { keepRecentTurns, toolResultTruncate } = options;

  // System = original system prompt + tool prompt
  const toolPrompt = buildToolPrompt(req.tools);
  const system = [req.systemPrompt, toolPrompt].filter(Boolean).join("\n\n");

  // Split messages into "recent" and "older"
  const recentStart = Math.max(0, req.messages.length - keepRecentTurns);
  const olderMsgs = req.messages.slice(0, recentStart);
  const recentMsgs = req.messages.slice(recentStart);

  const parts: string[] = [];

  // Summarize older messages
  if (olderMsgs.length > 0) {
    parts.push("=== 历史摘要 ===");
    for (const msg of olderMsgs) {
      const text = formatMessage(msg, toolResultTruncate);
      if (text) parts.push(text);
    }
    parts.push("=== 历史摘要结束 ===\n");
  }

  // Recent messages in full
  for (const msg of recentMsgs) {
    const text = formatMessage(msg, toolResultTruncate);
    if (text) parts.push(text);
  }

  // If the last message is not a user message, add a continuation prompt
  const lastMsg = req.messages[req.messages.length - 1];
  if (lastMsg && lastMsg.role !== "user") {
    parts.push("[user] 请继续。");
  }

  return { system, userMessage: parts.join("\n") };
}

function formatMessage(
  msg: { role: string; text: string; toolCallId?: string; toolName?: string },
  truncateLen: number,
): string {
  switch (msg.role) {
    case "user":
      return `[user] ${msg.text}`;
    case "assistant":
      return `[assistant] ${msg.text}`;
    case "tool_result": {
      let text = msg.text;
      if (text.length > truncateLen) {
        const original = text.length;
        text = text.slice(0, truncateLen) + `...[truncated ${original}→${truncateLen}]`;
      }
      const name = msg.toolName || "unknown";
      return `[tool ${name} 返回] ${text}`;
    }
    default:
      return "";
  }
}
