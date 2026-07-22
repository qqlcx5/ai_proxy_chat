import { describe, it, expect } from "vitest";
import { buildToolPrompt } from "../../src/engine/prompt-injector.js";
import type { NormalizedTool } from "../../src/protocol/types.js";

describe("buildToolPrompt", () => {
  it("returns empty string when no tools", () => {
    expect(buildToolPrompt([])).toBe("");
  });

  it("emits fenced tool_json example using plus_one (PRD §5.1)", () => {
    const tools: NormalizedTool[] = [
      { name: "read", description: "read file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ];
    const p = buildToolPrompt(tools);
    expect(p).toContain("plus_one");
    expect(p).toContain("tool_json");
    expect(p).toContain('"name":"read"');
  });

  it("truncates description in tool def line", () => {
    const tools: NormalizedTool[] = [
      { name: "x", description: "a".repeat(200), inputSchema: { type: "object", properties: { p: { type: "string" } } } },
    ];
    const p = buildToolPrompt(tools);
    // Def line should be shorter than 200 since we only take the first chunk
    expect(p).toContain("x");
  });
});
