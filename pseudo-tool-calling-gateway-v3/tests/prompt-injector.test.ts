import { describe, it, expect } from "vitest";
import { buildToolPrompt, buildFlattenedPrompt } from "../src/engine/prompt-injector.js";
import type { InternalRequest } from "../src/protocol/types.js";

describe("Prompt Injector", () => {
  it("builds tool prompt with compact definitions", () => {
    const prompt = buildToolPrompt([
      {
        name: "read",
        description: "Read a file from the local filesystem",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "exec",
        description: "Run a shell command",
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ]);

    // Should contain tool names
    expect(prompt).toContain("read");
    expect(prompt).toContain("exec");

    // Should contain the teaching example
    expect(prompt).toContain("plus_one");
    expect(prompt).toContain("tool_json");

    // Should NOT contain full JSON Schema
    expect(prompt).not.toContain('"required"');
    expect(prompt).not.toContain('"type":"object"');

    // Length check: should be compact
    expect(prompt.length).toBeLessThan(600);
  });

  it("returns empty string for no tools", () => {
    expect(buildToolPrompt([])).toBe("");
  });

  it("builds flattened prompt with system + tool prompt + messages", () => {
    const req: InternalRequest = {
      model: "gpt-5.6-luna",
      systemPrompt: "You are a coding assistant.",
      messages: [
        { role: "user", text: "Read README.md" },
        { role: "assistant", text: "[调用工具 read({\"path\":\"README.md\"})]" },
        { role: "tool_result", text: "# Project Title\nA great project.", toolCallId: "tc_1", toolName: "read" },
        { role: "user", text: "Summarize it" },
      ],
      tools: [
        {
          name: "read",
          description: "Read file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      stream: false,
      _protocol: "anthropic",
      _raw: {},
    };

    const result = buildFlattenedPrompt(req, {
      keepRecentTurns: 3,
      toolResultTruncate: 2000,
    });

    // System should contain original + tool prompt
    expect(result.system).toContain("You are a coding assistant.");
    expect(result.system).toContain("Tool Calling");

    // User message should contain the conversation
    expect(result.userMessage).toContain("[user] Read README.md");
    expect(result.userMessage).toContain("[tool read 返回]");
    expect(result.userMessage).toContain("[user] Summarize it");
  });

  it("truncates long tool results", () => {
    const longText = "x".repeat(5000);
    const req: InternalRequest = {
      model: "gpt-5.6-luna",
      systemPrompt: "",
      messages: [
        { role: "user", text: "Read big.txt" },
        { role: "tool_result", text: longText, toolCallId: "tc_1", toolName: "read" },
        { role: "user", text: "Continue" },
      ],
      tools: [],
      stream: false,
      _protocol: "anthropic",
      _raw: {},
    };

    const result = buildFlattenedPrompt(req, {
      keepRecentTurns: 3,
      toolResultTruncate: 100,
    });

    expect(result.userMessage).toContain("[truncated 5000→100]");
    expect(result.userMessage.length).toBeLessThan(longText.length);
  });

  it("summarizes older turns when keepRecentTurns < total", () => {
    const req: InternalRequest = {
      model: "gpt-5.6-luna",
      systemPrompt: "",
      messages: [
        { role: "user", text: "msg1" },
        { role: "assistant", text: "reply1" },
        { role: "user", text: "msg2" },
        { role: "assistant", text: "reply2" },
        { role: "user", text: "msg3" },
      ],
      tools: [],
      stream: false,
      _protocol: "anthropic",
      _raw: {},
    };

    const result = buildFlattenedPrompt(req, {
      keepRecentTurns: 2,
      toolResultTruncate: 2000,
    });

    // Older messages should be in summary section
    expect(result.userMessage).toContain("历史摘要");
    expect(result.userMessage).toContain("[user] msg1");
    expect(result.userMessage).toContain("历史摘要结束");

    // Recent messages should be outside summary
    expect(result.userMessage).toContain("[user] msg3");
  });
});
