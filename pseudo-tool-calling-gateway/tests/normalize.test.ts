/**
 * Normalize tests — verify each protocol request maps to the IR correctly.
 * Especially multi-turn: assistant tool_use/tool_calls history must survive.
 */
import { describe, it, expect } from "vitest";
import { normalizeAnthropic, normalizeOpenAiChat, normalizeOpenAiResponses } from "../src/protocol/normalize.js";

describe("normalizeOpenAiChat", () => {
  it("extracts system prompt and user message", () => {
    const ir = normalizeOpenAiChat({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(ir.systemPrompt).toBe("be brief");
    expect(ir.messages).toEqual([{ role: "user", text: "hi" }]);
    expect(ir.protocol).toBe("openai-chat");
    expect(ir.stream).toBe(false);
  });

  it("parses function tools into normalized tools", () => {
    const ir = normalizeOpenAiChat({
      model: "x",
      messages: [{ role: "user", content: "x" }],
      tools: [{
        type: "function",
        function: { name: "read", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      }],
    });
    expect(ir.tools).toHaveLength(1);
    expect(ir.tools[0]).toMatchObject({ name: "read", description: "Read file" });
  });

  it("preserves assistant tool_calls history in multi-turn", () => {
    const ir = normalizeOpenAiChat({
      model: "x",
      messages: [
        { role: "user", content: "read foo" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"foo"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "FOO CONTENT" },
      ],
    });
    expect(ir.messages[1]).toMatchObject({ role: "assistant" });
    expect(ir.messages[1].text).toContain("[called tool read");
    expect(ir.messages[2]).toMatchObject({ role: "tool_result", text: "FOO CONTENT", toolCallId: "c1" });
  });
});

describe("normalizeAnthropic", () => {
  it("extracts system + tools + messages", () => {
    const ir = normalizeAnthropic({
      model: "x",
      system: "you are helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "Read file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    });
    expect(ir.systemPrompt).toBe("you are helpful");
    expect(ir.tools[0]).toMatchObject({ name: "read" });
    expect(ir.messages).toEqual([{ role: "user", text: "hi" }]);
  });

  it("preserves assistant tool_use history in multi-turn", () => {
    const ir = normalizeAnthropic({
      model: "x",
      messages: [
        { role: "user", content: "read foo" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { path: "foo" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "FOO" }] },
      ],
    });
    expect(ir.messages[1].text).toContain("[called tool read");
    expect(ir.messages[2]).toMatchObject({ role: "tool_result", text: "FOO", toolCallId: "tu1" });
  });

  it("handles system as content array", () => {
    const ir = normalizeAnthropic({
      model: "x",
      system: [{ type: "text", text: "multi-block system" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ir.systemPrompt).toBe("multi-block system");
  });
});

describe("normalizeOpenAiResponses", () => {
  it("extracts instructions + string input", () => {
    const ir = normalizeOpenAiResponses({
      model: "x",
      instructions: "be brief",
      input: "hello",
      tools: [{ type: "function", name: "read", description: "r", parameters: {} }],
    });
    expect(ir.systemPrompt).toBe("be brief");
    expect(ir.messages).toEqual([{ role: "user", text: "hello" }]);
    expect(ir.tools[0]).toMatchObject({ name: "read" });
  });

  it("handles array input with function_call_output", () => {
    const ir = normalizeOpenAiResponses({
      model: "x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "read foo" }] },
        { type: "function_call_output", call_id: "c1", output: "FOO" },
      ],
    });
    expect(ir.messages[0]).toMatchObject({ role: "user", text: "read foo" });
    expect(ir.messages[1]).toMatchObject({ role: "tool_result", text: "FOO", toolCallId: "c1" });
  });
});
