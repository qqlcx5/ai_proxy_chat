/**
 * Denormalize contract tests — verify IR → protocol response shapes.
 * Key gotcha (PRD §3.2): OpenAI arguments must be stringified JSON.
 */
import { describe, it, expect } from "vitest";
import {
  denormalizeOpenAiChat,
  denormalizeAnthropic,
  denormalizeOpenAiResponses,
  denormalizeOpenAiChatStream,
  denormalizeAnthropicStream,
  denormalizeOpenAiResponsesStream,
} from "../src/protocol/denormalize.js";
import type { InternalResponse } from "../src/protocol/types.js";

const textRes: InternalResponse = { text: "hello", toolCalls: [], stopReason: "end_turn" };
const toolRes: InternalResponse = {
  text: "",
  toolCalls: [{ tool: "read", parameters: { path: "foo.txt" } }],
  stopReason: "tool_use",
};

describe("denormalizeOpenAiChat", () => {
  it("text response: finish_reason stop", () => {
    const out: any = denormalizeOpenAiChat(textRes);
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.choices[0].message.content).toBe("hello");
    expect(out.choices[0].message.tool_calls).toBeUndefined();
  });

  it("tool response: tool_calls with stringified arguments", () => {
    const out: any = denormalizeOpenAiChat(toolRes);
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    const tc = out.choices[0].message.tool_calls[0];
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("read");
    // CRITICAL: arguments is a STRING, not object
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: "foo.txt" });
  });
});

describe("denormalizeAnthropic", () => {
  it("text response: text content block + end_turn", () => {
    const out: any = denormalizeAnthropic(textRes);
    expect(out.content[0]).toEqual({ type: "text", text: "hello" });
    expect(out.stop_reason).toBe("end_turn");
  });

  it("tool response: tool_use block with object input + tool_use", () => {
    const out: any = denormalizeAnthropic(toolRes);
    const block = out.content[0];
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("read");
    // Anthropic input is an OBJECT (unlike OpenAI string)
    expect(block.input).toEqual({ path: "foo.txt" });
    expect(out.stop_reason).toBe("tool_use");
  });
});

describe("denormalizeOpenAiResponses", () => {
  it("text response: message with output_text", () => {
    const out: any = denormalizeOpenAiResponses(textRes);
    expect(out.output[0].type).toBe("message");
    expect(out.output[0].content[0]).toEqual({ type: "output_text", text: "hello" });
  });

  it("tool response: function_call with stringified arguments", () => {
    const out: any = denormalizeOpenAiResponses(toolRes);
    const fc = out.output.find((o: any) => o.type === "function_call");
    expect(fc.name).toBe("read");
    expect(typeof fc.arguments).toBe("string");
    expect(JSON.parse(fc.arguments)).toEqual({ path: "foo.txt" });
    expect(fc.call_id).toBeTruthy();
  });
});

describe("denormalizeOpenAiChatStream", () => {
  it("text stream: emits content delta + stop + [DONE]", () => {
    const chunks = denormalizeOpenAiChatStream(textRes);
    expect(chunks.at(-1)).toBe("[DONE]");
    const stopChunk = chunks.at(-2)!;
    expect(stopChunk).toContain('"finish_reason":"stop"');
    const contentChunk = chunks.find((c) => c.includes('"content":"hello"'));
    expect(contentChunk).toBeTruthy();
  });

  it("tool stream: emits tool_calls delta + tool_calls finish", () => {
    const chunks = denormalizeOpenAiChatStream(toolRes);
    const toolChunk = chunks.find((c) => c.includes('"tool_calls"'));
    expect(toolChunk).toBeTruthy();
    expect(toolChunk).toContain('"name":"read"');
    const finish = chunks.at(-2)!;
    expect(finish).toContain('"finish_reason":"tool_calls"');
  });
});

describe("denormalizeAnthropicStream", () => {
  it("text stream: message_start → text deltas → message_delta(end_turn) → message_stop", () => {
    const chunks = denormalizeAnthropicStream(textRes);
    const joined = chunks.join("");
    expect(joined).toContain("event: message_start");
    expect(joined).toContain('"type":"text_delta"');
    expect(joined).toContain('"stop_reason":"end_turn"');
    expect(joined).toContain("event: message_stop");
  });

  it("tool stream: content_block_start(tool_use) → input_json_delta → stop_reason tool_use", () => {
    const chunks = denormalizeAnthropicStream(toolRes);
    const joined = chunks.join("");
    expect(joined).toContain('"type":"tool_use"');
    expect(joined).toContain('"type":"input_json_delta"');
    // input is stringified JSON in the partial_json delta
    expect(joined).toContain('\\"path\\":\\"foo.txt\\"');
    expect(joined).toContain('"stop_reason":"tool_use"');
  });
});

describe("denormalizeOpenAiResponsesStream", () => {
  it("text stream: response.created → output_text delta → response.completed", () => {
    const chunks = denormalizeOpenAiResponsesStream(textRes);
    const joined = chunks.join("");
    expect(joined).toContain("event: response.created");
    expect(joined).toContain("event: response.output_text.delta");
    expect(joined).toContain("event: response.completed");
    expect(joined).toContain('"status":"completed"');
  });

  it("tool stream: function_call arguments delta/done, id consistent in completed", () => {
    const chunks = denormalizeOpenAiResponsesStream(toolRes);
    const joined = chunks.join("");
    expect(joined).toContain("event: response.function_call_arguments.delta");
    expect(joined).toContain("event: response.function_call_arguments.done");
    // id consistency: the fc id in output_item.added should match output_item.done
    const addedMatch = joined.match(/"type":"function_call","id":"(fc_[^"]+)","call_id":"(call_[^"]+)","name":"read","arguments":"","status":"in_progress"/);
    const doneMatch = joined.match(/"type":"function_call","id":"(fc_[^"]+)","call_id":"(call_[^"]+)","name":"read","arguments":".{0,40}","status":"completed"/);
    expect(addedMatch).toBeTruthy();
    expect(doneMatch).toBeTruthy();
    expect(addedMatch![1]).toBe(doneMatch![1]); // same fc id
    expect(addedMatch![2]).toBe(doneMatch![2]); // same call_id
  });
});
