import { describe, it, expect } from "vitest";
import { normalizeAnthropic, normalizeOpenAIChat, normalizeOpenAIResponses } from "../src/protocol/normalize.js";
import { denormalizeAnthropic, denormalizeOpenAIChat, denormalizeOpenAIResponses } from "../src/protocol/denormalize.js";
import type { InternalResponse } from "../src/protocol/types.js";

describe("Normalize — Anthropic", () => {
  it("normalizes system + user + tools", () => {
    const body = {
      model: "gpt-5.6-luna",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Read README.md" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
      stream: false,
      max_tokens: 1024,
    };
    const req = normalizeAnthropic(body);
    expect(req.model).toBe("gpt-5.6-luna");
    expect(req.systemPrompt).toBe("You are helpful.");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].text).toBe("Read README.md");
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0].name).toBe("read");
    expect(req._protocol).toBe("anthropic");
  });

  it("normalizes tool_use and tool_result", () => {
    const body = {
      model: "gpt-5.6-luna",
      messages: [
        { role: "user", content: "Read foo.py" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read it." },
            { type: "tool_use", id: "tu_1", name: "read", input: { path: "foo.py" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "print('hi')" }],
        },
      ],
    };
    const req = normalizeAnthropic(body);
    expect(req.messages).toHaveLength(4);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].text).toBe("Let me read it.");
    expect(req.messages[2].role).toBe("assistant");
    expect(req.messages[2].text).toContain("调用工具 read");
    expect(req.messages[3].role).toBe("tool_result");
    expect(req.messages[3].text).toBe("print('hi')");
    expect(req.messages[3].toolCallId).toBe("tu_1");
  });
});

describe("Normalize — OpenAI Chat", () => {
  it("normalizes system + user + tools", () => {
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Run ls" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "exec",
            description: "Run command",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        },
      ],
      stream: true,
    };
    const req = normalizeOpenAIChat(body);
    expect(req.systemPrompt).toBe("Be helpful.");
    expect(req.messages).toHaveLength(1);
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0].name).toBe("exec");
    expect(req._protocol).toBe("openai-chat");
  });

  it("normalizes tool_calls and tool role", () => {
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "Read a.py" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.py"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "print(1)" },
      ],
    };
    const req = normalizeOpenAIChat(body);
    expect(req.messages).toHaveLength(3);
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[1].text).toContain("read");
    expect(req.messages[2].role).toBe("tool_result");
    expect(req.messages[2].text).toBe("print(1)");
  });
});

describe("Normalize — OpenAI Responses", () => {
  it("normalizes instructions + input + tools", () => {
    const body = {
      model: "gpt-5.6-luna",
      instructions: "Be concise.",
      input: [
        { type: "message", role: "user", content: "List files" },
      ],
      tools: [
        { type: "function", name: "exec", description: "Run", parameters: { type: "object", properties: { command: { type: "string" } } } },
      ],
      stream: false,
    };
    const req = normalizeOpenAIResponses(body);
    expect(req.systemPrompt).toBe("Be concise.");
    expect(req.messages).toHaveLength(1);
    expect(req.tools).toHaveLength(1);
    expect(req._protocol).toBe("openai-responses");
  });

  it("normalizes function_call and function_call_output", () => {
    const body = {
      model: "gpt-5.6-luna",
      input: [
        { type: "message", role: "user", content: "Read x" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"x"}' },
        { type: "function_call_output", call_id: "call_1", output: "content of x" },
      ],
    };
    const req = normalizeOpenAIResponses(body);
    expect(req.messages).toHaveLength(3);
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[2].role).toBe("tool_result");
    expect(req.messages[2].text).toBe("content of x");
  });
});

// ─── Denormalize round-trip ──────────────────────────────────────────

describe("Denormalize — text only", () => {
  const textResp: InternalResponse = {
    text: "Hello world",
    toolCalls: [],
    stopReason: "stop",
  };

  it("denormalizes to Anthropic format", () => {
    const result = denormalizeAnthropic(textResp, "gpt-5.6-luna");
    expect(result.role).toBe("assistant");
    expect(result.stop_reason).toBe("end_turn");
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as unknown[])[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("denormalizes to OpenAI Chat format", () => {
    const result = denormalizeOpenAIChat(textResp, "gpt-5.6-luna");
    expect(result.object).toBe("chat.completion");
    const choice = (result.choices as unknown[])[0] as Record<string, unknown>;
    expect(choice.finish_reason).toBe("stop");
    const message = choice.message as Record<string, unknown>;
    expect(message.content).toBe("Hello world");
  });

  it("denormalizes to OpenAI Responses format", () => {
    const result = denormalizeOpenAIResponses(textResp, "gpt-5.6-luna");
    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(Array.isArray(result.output)).toBe(true);
  });
});

describe("Denormalize — tool calls", () => {
  const toolResp: InternalResponse = {
    text: "",
    toolCalls: [{ tool: "read", parameters: { path: "README.md" } }],
    stopReason: "tool_use",
  };

  it("denormalizes to Anthropic tool_use", () => {
    const result = denormalizeAnthropic(toolResp, "gpt-5.6-luna");
    expect(result.stop_reason).toBe("tool_use");
    const content = result.content as unknown[];
    expect(content[0]).toMatchObject({ type: "tool_use", name: "read" });
  });

  it("denormalizes to OpenAI Chat tool_calls", () => {
    const result = denormalizeOpenAIChat(toolResp, "gpt-5.6-luna");
    const choice = (result.choices as unknown[])[0] as Record<string, unknown>;
    expect(choice.finish_reason).toBe("tool_calls");
    const message = choice.message as Record<string, unknown>;
    const toolCalls = message.tool_calls as unknown[];
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0] as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown>;
    // arguments must be a string (JSON.stringify'd)
    expect(typeof fn.arguments).toBe("string");
    expect(JSON.parse(fn.arguments as string)).toEqual({ path: "README.md" });
  });

  it("denormalizes to OpenAI Responses function_call", () => {
    const result = denormalizeOpenAIResponses(toolResp, "gpt-5.6-luna");
    const output = result.output as unknown[];
    expect(output).toHaveLength(1);
    const item = output[0] as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(typeof item.arguments).toBe("string");
    expect(JSON.parse(item.arguments as string)).toEqual({ path: "README.md" });
  });
});
