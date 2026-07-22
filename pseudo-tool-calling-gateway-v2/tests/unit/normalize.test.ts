import { describe, it, expect } from "vitest";
import { normalize, normalizeAnthropic, normalizeOpenAiChat, normalizeOpenAiResponses } from "../../src/protocol/normalize.js";

describe("normalize — OpenAI Chat", () => {
  it("extracts system + user messages", () => {
    const ir = normalizeOpenAiChat({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(ir.systemPrompt).toBe("be terse");
    expect(ir.messages).toEqual([{ role: "user", text: "hi", toolCallId: undefined, toolName: undefined }]);
  });

  it("preserves assistant tool_calls and produces a tool_result for the tool message", () => {
    const ir = normalizeOpenAiChat({
      model: "gpt-5.6-luna",
      messages: [
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }] },
        { role: "tool", tool_call_id: "c1", name: "read", content: "x" },
      ],
    });
    expect(ir.messages[0]?.role).toBe("assistant");
    expect(ir.messages[0]?.text).toContain("[assistant tool_use read]");
    expect(ir.messages[1]?.role).toBe("tool_result");
    expect(ir.messages[1]?.toolCallId).toBe("c1");
    expect(ir.messages[1]?.toolName).toBe("read");
  });

  it("extracts tools[].function.parameters", () => {
    const ir = normalizeOpenAiChat({
      model: "gpt-5.6-luna",
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
      messages: [],
    });
    expect(ir.tools[0]).toMatchObject({ name: "read", description: "r" });
  });
});

describe("normalize — Anthropic", () => {
  it("handles string system and inline content blocks", () => {
    const ir = normalizeAnthropic({
      model: "x",
      system: "you are claude",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    });
    expect(ir.systemPrompt).toBe("you are claude");
    expect(ir.messages).toEqual([
      { role: "user", text: "hi", toolCallId: undefined, toolName: undefined },
      { role: "assistant", text: "ok", toolCallId: undefined, toolName: undefined },
    ]);
  });

  it("flattens user content[].type=tool_result", () => {
    const ir = normalizeAnthropic({
      model: "x",
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file content" }] },
      ],
    });
    expect(ir.messages[0]).toMatchObject({ role: "tool_result", toolCallId: "tu1", text: "file content" });
  });
});

describe("normalize — OpenAI Responses", () => {
  it("handles string input", () => {
    const ir = normalizeOpenAiResponses({ model: "x", input: "hi" });
    expect(ir.messages[0]?.text).toBe("hi");
  });

  it("flattens function_call_output", () => {
    const ir = normalizeOpenAiResponses({
      model: "x",
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    expect(ir.messages[0]?.role).toBe("user");
    expect(ir.messages[1]?.role).toBe("tool_result");
    expect(ir.messages[1]?.toolCallId).toBe("c1");
    expect(ir.messages[1]?.text).toBe("ok");
  });
});

describe("normalize — dispatch", () => {
  it("routes by protocol", () => {
    expect(normalize("anthropic", { model: "x", messages: [] }).protocol).toBe("anthropic");
    expect(normalize("openai-chat", { model: "x", messages: [] }).protocol).toBe("openai-chat");
    expect(normalize("openai-responses", { model: "x", input: "" }).protocol).toBe("openai-responses");
  });
});
