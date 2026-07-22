import { describe, it, expect } from "vitest";
import { extractToolCall } from "../../src/engine/parser.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const GOLDEN = join(import.meta.dirname, "..", "golden");

interface Expected { tool: string; parameters: Record<string, unknown> }

function loadExpected(base: string): Expected | null {
  try {
    return JSON.parse(readFileSync(`${GOLDEN}/${base}.expected.json`, "utf8")) as Expected;
  } catch { return null; }
}

describe("parser — golden corpus", () => {
  const files = readdirSync(GOLDEN).filter((f) => f.endsWith(".txt"));
  for (const f of files) {
    it(f, () => {
      const text = readFileSync(`${GOLDEN}/${f}`, "utf8");
      const expected = loadExpected(f.replace(/\.txt$/, ""));
      if (!expected) {
        // File with no expected → must NOT parse anything
        expect(extractToolCall(text)).toBeNull();
        return;
      }
      const got = extractToolCall(text);
      expect(got).not.toBeNull();
      expect(got!.tool).toBe(expected.tool);
      expect(got!.parameters).toEqual(expected.parameters);
    });
  }
});

describe("parser — bracket repair", () => {
  it("auto-closes missing braces", () => {
    const r = extractToolCall('```tool_json\n{"tool":"read","parameters":{"path":"/x"}');
    expect(r).toEqual({ tool: "read", parameters: { path: "/x" } });
  });

  it("handles name/arguments (OpenAI bare) variant", () => {
    const r = extractToolCall('```tool_json\n{"name":"exec","arguments":{"command":"ls"}}\n```');
    expect(r).toEqual({ tool: "exec", parameters: { command: "ls" } });
  });

  it("returns null on plain prose", () => {
    expect(extractToolCall("just chatting, no tool needed.")).toBeNull();
  });
});
