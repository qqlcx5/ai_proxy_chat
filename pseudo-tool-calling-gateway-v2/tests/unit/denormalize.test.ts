import { describe, it, expect } from "vitest";
import {
  denormalizeOpenAiChat,
  denormalizeOpenAiChatStream,
  denormalizeAnthropic,
  denormalizeOpenAiResponses,
  denormalizeOpenAiResponsesStream,
} from "../../src/protocol/denormalize.js";
import type { InternalResponse } from "../../src/protocol/types.js";

const TEXT_ONLY: InternalResponse = { text: "Hello world", toolCalls: [], stopReason: "end_turn" };
const TOOL_ONLY: InternalResponse = {
  text: "",
  toolCalls: [{ tool: "read", parameters: { path: "/tmp/x" } }],
  stopReason: "tool_use",
};

describe("denormalize — OpenAI Chat", () => {
  it("text-only → content + finish_reason=stop", () => {
    const r = denormalizeOpenAiChat(TEXT_ONLY) as Record<string, any>;
    expect(r.choices[0].message.content).toBe("Hello world");
    expect(r.choices[0].finish_reason).toBe("stop");
  });

  it("tool_call → arguments is a JSON STRING (not object)", () => {
    const r = denormalizeOpenAiChat(TOOL_ONLY) as Record<string, any>;
    const tc = r.choices[0].message.tool_calls[0];
    expect(tc.type).toBe("function");
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: "/tmp/x" });
    expect(r.choices[0].finish_reason).toBe("tool_calls");
  });

  it("stream yields role-delta + content + finish + [DONE]", () => {
    const chunks = denormalizeOpenAiChatStream(TOOL_ONLY);
    expect(chunks[0]).toContain('"role":"assistant"');
    expect(chunks.at(-1)).toBe("[DONE]");
    const allData = chunks.filter((c) => c.startsWith("data:") && !c.includes("[DONE]")).join("");
    expect(allData).toContain('"finish_reason":"tool_calls"');
  });
});

describe("denormalize — Anthropic", () => {
  it("text-only → content[].type=text + stop_reason=end_turn", () => {
    const r = denormalizeAnthropic(TEXT_ONLY) as Record<string, any>;
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toBe("Hello world");
    expect(r.stop_reason).toBe("end_turn");
  });

  it("tool_call → content[].type=tool_use + stop_reason=tool_use", () => {
    const r = denormalizeAnthropic(TOOL_ONLY) as Record<string, any>;
    expect(r.content[0].type).toBe("tool_use");
    expect(r.content[0].name).toBe("read");
    expect(r.content[0].input).toEqual({ path: "/tmp/x" });
    expect(r.stop_reason).toBe("tool_use");
  });
});

describe("denormalize — OpenAI Responses", () => {
  it("text-only → output[].type=message.content[].type=output_text", () => {
    const r = denormalizeOpenAiResponses(TEXT_ONLY) as Record<string, any>;
    expect(r.status).toBe("completed");
    expect(r.output[0].type).toBe("message");
    expect(r.output[0].content[0].type).toBe("output_text");
    expect(r.output[0].content[0].text).toBe("Hello world");
  });

  it("tool_call → output[].type=function_call + arguments is STRING", () => {
    const r = denormalizeOpenAiResponses(TOOL_ONLY) as Record<string, any>;
    const fc = r.output[0];
    expect(fc.type).toBe("function_call");
    expect(typeof fc.arguments).toBe("string");
    expect(JSON.parse(fc.arguments)).toEqual({ path: "/tmp/x" });
  });

  it("stream yields response.created + response.completed", () => {
    const chunks = denormalizeOpenAiResponsesStream(TEXT_ONLY);
    const allData = chunks.filter((c) => c.startsWith("data:")).join("");
    expect(allData).toContain("response.created");
    expect(allData).toContain("response.completed");
    expect(chunks.at(-1)).toBe("[DONE]");
  });
});
