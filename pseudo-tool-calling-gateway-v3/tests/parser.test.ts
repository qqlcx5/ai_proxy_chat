import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractToolCall, extractToolCalls, hasToolCall, parseWithRepairInfo } from "../src/engine/parser.js";

const GOLDEN_DIR = join(import.meta.dirname, "golden");

describe("Parser — golden cases", () => {
  const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".txt"));

  for (const file of files) {
    it(`parses ${file}`, () => {
      const text = readFileSync(join(GOLDEN_DIR, file), "utf-8");
      const calls = extractToolCalls(text);

      // Files with "no-tool" should return no calls
      if (file.includes("no-tool")) {
        expect(calls).toHaveLength(0);
        expect(hasToolCall(text)).toBe(false);
        return;
      }

      // All other files should produce at least one call
      expect(calls.length).toBeGreaterThan(0);

      // Multi-call file should produce 2 calls
      if (file.includes("multi-call")) {
        expect(calls).toHaveLength(2);
        expect(calls[0].tool).toBe("read");
        expect(calls[1].tool).toBe("read");
      }

      // Verify tool name is correct for single-call files
      if (!file.includes("multi-call")) {
        // stream-dropped-brace uses exec
        if (file.includes("stream-dropped")) {
          expect(calls[0].tool).toBe("exec");
          expect(calls[0].parameters).toHaveProperty("command");
        } else {
          expect(calls[0].tool).toBe("read");
          expect(calls[0].parameters).toHaveProperty("path");
        }
      }
    });
  }
});

describe("Parser — format coverage", () => {
  it("parses fenced tool_json", () => {
    const text = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("exec");
    expect(call!.parameters).toEqual({ command: "ls" });
  });

  it("parses bare JSON", () => {
    const text = '{"tool":"write","parameters":{"path":"/tmp/a","content":"hi"}}';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("write");
    expect(call!.parameters).toEqual({ path: "/tmp/a", content: "hi" });
  });

  it("parses XML wrapped format", () => {
    const text = '<tool_call>{"tool":"read","parameters":{"path":"foo.py"}}</tool_call>';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("read");
    expect(call!.parameters).toEqual({ path: "foo.py" });
  });

  it("parses OpenAI style {name, arguments}", () => {
    const text = '{"name":"exec","arguments":{"command":"pwd"}}';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("exec");
    expect(call!.parameters).toEqual({ command: "pwd" });
  });

  it("parses OpenAI style with string arguments", () => {
    const text = '{"name":"exec","arguments":"{\\"command\\":\\"ls\\"}"}';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("exec");
    expect(call!.parameters).toEqual({ command: "ls" });
  });

  it("repairs truncated JSON (missing closing brace)", () => {
    const text = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}\n```';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("exec");
    expect(call!.parameters).toEqual({ command: "ls" });
  });

  it("repairs bare truncated JSON", () => {
    const text = '{"tool":"exec","parameters":{"command":"ls -la"}';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("exec");
  });

  it("repairs deeply truncated JSON (no closing braces at all)", () => {
    const text = '{"tool":"exec","parameters":{"command":"ls -la"';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe("exec");
    expect(call!.parameters).toEqual({ command: "ls -la" });
  });

  it("returns null for plain text", () => {
    const text = "Hello, I can help you with that!";
    const call = extractToolCall(text);
    expect(call).toBeNull();
    expect(hasToolCall(text)).toBe(false);
  });

  it("returns null for code that looks like JSON but isn't a tool call", () => {
    const text = '```json\n{"name":"Alice","age":30}\n```';
    const call = extractToolCall(text);
    expect(call).toBeNull();
  });

  it("handles multiple calls in one response", () => {
    const text = '```tool_json\n{"tool":"read","parameters":{"path":"a.ts"}}\n```\n```tool_json\n{"tool":"read","parameters":{"path":"b.ts"}}\n```';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(2);
  });

  it("parseWithRepairInfo returns repair info", () => {
    const clean = '```tool_json\n{"tool":"read","parameters":{"path":"x"}}\n```';
    const result = parseWithRepairInfo(clean);
    expect(result.calls).toHaveLength(1);
    expect(result.repairUsed).toBeNull();
  });
});
