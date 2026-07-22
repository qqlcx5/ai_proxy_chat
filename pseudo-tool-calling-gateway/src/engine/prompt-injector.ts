/**
 * Prompt injector — PRD §5.1.
 *
 * Converts the IR's tools list into a compact instruction block prepended to
 * the user message, teaching the model the tool_json output format.
 *
 * Design notes:
 *  - Compactness target: ≤ ~200 + N*80 chars for N tools (reverse APIs are
 *    prompt-length sensitive).
 *  - Strong directive: when tools are available AND the task plausibly needs
 *    one, the model MUST emit a tool_json block rather than answering from
 *    imagination. Empirically this lifts tool-call compliance from ~50% to
 *    ~100% on gpt-5.6-luna (see M2 measurement).
 *  - Teaching example uses a fake tool (plus_one) so the model doesn't confuse
 *    it with a real one (lesson from openclaw).
 */

import type { NormalizedTool } from "../protocol/types.js";

const FORMAT_INSTRUCTION = `When a relevant tool is available, you MUST call it via a fenced block instead of answering from memory:
\`\`\`tool_json
{"tool":"<name>","parameters":{...}}
\`\`\`
Reply ONLY with the block (no prose before/after). Never fabricate tool output — if you need data, call the tool.
Example (plus_one is NOT a real tool, just showing format):
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
If no tool is relevant, answer the user directly.`;

/**
 * Build the injected prompt for the given tools.
 * Returns "" when there are no tools — keeps normal chat short.
 */
export function buildToolPrompt(tools: NormalizedTool[]): string {
  if (tools.length === 0) return "";

  const defs = tools.map((t) => {
    const params = Object.keys(t.inputSchema.properties ?? {});
    return JSON.stringify({ name: t.name, desc: t.description, params });
  });

  return `Tools available:\n${defs.join("\n")}\n\n${FORMAT_INSTRUCTION}`;
}
