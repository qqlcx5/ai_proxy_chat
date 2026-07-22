/**
 * Parser golden tests — PRD §8.3.
 *
 * Each case is a model output sample with its expected parse result.
 * Guards the 4 input formats + brace-balance repair + no-tool text.
 */
import { describe, it, expect } from "vitest";
import { extractToolCall } from "../src/engine/parser.js";

describe("extractToolCall", () => {
  it("parses clean fenced tool_json", () => {
    const text = "```tool_json\n" + JSON.stringify({ tool: "read", parameters: { path: "foo.txt" } }) + "\n```";
    expect(extractToolCall(text)).toEqual({ tool: "read", parameters: { path: "foo.txt" } });
  });

  it("parses fenced block with trailing prose (strips it)", () => {
    const text = "Sure!\n```tool_json\n" + JSON.stringify({ tool: "read", parameters: { path: "a" } }) + "\n```\nDone.";
    expect(extractToolCall(text)).toEqual({ tool: "read", parameters: { path: "a" } });
  });

  it("parses bare {tool,parameters} JSON", () => {
    const text = '{"tool":"exec","parameters":{"command":"ls"}}';
    expect(extractToolCall(text)).toEqual({ tool: "exec", parameters: { command: "ls" } });
  });

  it("parses OpenAI-style {name,arguments}", () => {
    const text = '{"name":"write","arguments":{"path":"x","content":"y"}}';
    expect(extractToolCall(text)).toEqual({ tool: "write", parameters: { path: "x", content: "y" } });
  });

  it("parses XML-wrapped tool_call", () => {
    const text = '<tool_call>{"tool":"read","parameters":{"path":"z"}}</tool_call>';
    expect(extractToolCall(text)).toEqual({ tool: "read", parameters: { path: "z" } });
  });

  it("repairs truncated SSE output (missing closing brace)", () => {
    // Simulates stream dropping the final "}"
    const text = '{"tool":"read","parameters":{"path":"a.txt"}';
    expect(extractToolCall(text)).toEqual({ tool: "read", parameters: { path: "a.txt" } });
  });

  it("returns null for plain text with no tool call", () => {
    expect(extractToolCall("hello world, just chatting")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractToolCall("")).toBeNull();
  });

  it("returns null for malformed JSON that can't be repaired", () => {
    expect(extractToolCall('{"tool":')).toBeNull();
  });

  it("handles parameters with nested object", () => {
    const text = '```tool_json\n' + JSON.stringify({ tool: "search", parameters: { opts: { limit: 5 } } }) + '\n```';
    expect(extractToolCall(text)).toEqual({ tool: "search", parameters: { opts: { limit: 5 } } });
  });
});
