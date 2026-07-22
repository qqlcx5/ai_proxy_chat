import type { NormalizedTool } from "../protocol/types.js";

const FORMAT_INSTRUCTION = `To call a tool, reply ONLY with a fenced block:
\`\`\`tool_json
{"tool":"<name>","parameters":{...}}
\`\`\`
Example (plus_one is NOT a real tool, just showing format):
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
If no tool is needed, answer directly without any code block.`;

export function buildToolPrompt(tools: NormalizedTool[]): string {
  if (tools.length === 0) return "";
  const defs = tools.map((t) => {
    const params = Object.keys(t.inputSchema.properties ?? {});
    return JSON.stringify({ name: t.name, desc: t.description, params });
  });
  return `Tools available:\n${defs.join("\n")}\n\n${FORMAT_INSTRUCTION}`;
}
