/**
 * Reverse-parses the gateway's forged responses through the OFFICIAL
 * SDKs. This is the single most useful test in the project: it catches
 * "arguments must be a string" / "stop_reason must be tool_use" / etc.
 *
 * We don't make network calls; we only feed the SDK's type system.
 */

import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  denormalizeAnthropic,
  denormalizeOpenAiChat,
  denormalizeOpenAiResponses,
} from "../../src/protocol/denormalize.js";
import type { InternalResponse } from "../../src/protocol/types.js";

const TOOL_RESP: InternalResponse = {
  text: "",
  toolCalls: [{ tool: "read", parameters: { path: "/tmp/foo.md" } }],
  stopReason: "tool_use",
};

describe("contract — @anthropic-ai/sdk accepts our /v1/messages", () => {
  it("tool_use block shape satisfies Anthropic.Message", () => {
    const wire = denormalizeAnthropic(TOOL_RESP) as Anthropic.Messages.Message;
    // Type-level: if the cast was wrong, the type-checked line below errors.
    // At runtime, we only verify the shape matches.
    expect(wire.content[0]!.type).toBe("tool_use");
    if (wire.content[0]!.type === "tool_use") {
      expect(wire.content[0]!.name).toBe("read");
      expect(wire.content[0]!.input).toEqual({ path: "/tmp/foo.md" });
    }
    expect(wire.stop_reason).toBe("tool_use");
  });
});

describe("contract — openai SDK accepts our /v1/chat/completions", () => {
  it("tool_calls[].function.arguments is a STRING", () => {
    const wire = denormalizeOpenAiChat(TOOL_RESP) as OpenAI.Chat.ChatCompletion;
    const choice = wire.choices[0]!;
    const tcs = choice.message.tool_calls!;
    expect(tcs.length).toBe(1);
    const tc = tcs[0]!;
    if (tc.type === "function") {
      expect(typeof tc.function.arguments).toBe("string");
      expect(JSON.parse(tc.function.arguments)).toEqual({ path: "/tmp/foo.md" });
    } else {
      throw new Error("expected function tool call");
    }
    expect(choice.finish_reason).toBe("tool_calls");
  });
});

describe("contract — openai SDK accepts our /v1/responses", () => {
  it("output[].type=function_call.arguments is a STRING", () => {
    // openai 4.77 hasn't shipped the Responses namespace; we verify the
    // structural contract only.
    const wire = denormalizeOpenAiResponses(TOOL_RESP) as { output: Array<{ type: string; arguments: string }> };
    const fc = wire.output[0]!;
    expect(fc.type).toBe("function_call");
    expect(typeof fc.arguments).toBe("string");
    expect(JSON.parse(fc.arguments)).toEqual({ path: "/tmp/foo.md" });
  });
});
