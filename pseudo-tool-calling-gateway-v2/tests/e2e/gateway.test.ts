/**
 * End-to-end: boot a mock upstream + boot the gateway, drive real
 * HTTP through the real OpenAI/Anthropic SDKs. Catches integration
 * bugs that unit tests can't.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "../../src/server/router.js";
import { GatewayConfig } from "../../src/config/gateway.js";

let upstream: ReturnType<typeof serve>;
let gateway: ReturnType<typeof serve>;
let gwPort = 0;
let upPort = 0;

const UPSTREAM_MODEL = "gpt-5.6-luna-¥40/1M";

beforeAll(async () => {
  // 1. mock upstream — gateway ALWAYS calls upstream with stream=true
  //    and parses the SSE. Mock always returns SSE.
  const mock = new Hono();
  mock.post("/chat/completions", async () => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        send({ id: "m1", object: "chat.completion.chunk", model: UPSTREAM_MODEL,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        send({ id: "m1", object: "chat.completion.chunk", model: UPSTREAM_MODEL,
          choices: [{ index: 0, delta: { content: '```tool_json\n{"tool":"read","parameters":{"path":"/tmp/README.md"}}\n```' }, finish_reason: null }] });
        send({ id: "m1", object: "chat.completion.chunk", model: UPSTREAM_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });

  await new Promise<void>((resolve) => {
    upstream = serve({ fetch: mock.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      upPort = info.port;
      resolve();
    });
  });

  // 2. gateway config pointed at the mock
  process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${upPort}`;
  process.env.UPSTREAM_API_KEY = "test";
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GATEWAY_PORT = "0";
  const cfg = new GatewayConfig();
  const app = createApp(cfg);
  await new Promise<void>((resolve) => {
    gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      gwPort = info.port;
      resolve();
    });
  });
});

afterAll(() => {
  upstream?.close();
  gateway?.close();
});

describe("e2e — OpenAI Chat over /v1/chat/completions", () => {
  it("returns a forged tool_call when the upstream emits a tool_json block", async () => {
    const client = new OpenAI({ apiKey: "x", baseURL: `http://127.0.0.1:${gwPort}/v1` });
    const r = await client.chat.completions.create({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "read README" }],
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    });
    expect(r.choices[0]!.finish_reason).toBe("tool_calls");
    const tc = r.choices[0]!.message.tool_calls?.[0];
    expect(tc?.type).toBe("function");
    if (tc?.type === "function") {
      expect(tc.function.name).toBe("read");
      expect(JSON.parse(tc.function.arguments)).toEqual({ path: "/tmp/README.md" });
    }
  });
});

describe("e2e — Anthropic Messages over /v1/messages", () => {
  it("returns a forged tool_use block", async () => {
    const client = new Anthropic({ apiKey: "x", baseURL: `http://127.0.0.1:${gwPort}` });
    const r = await client.messages.create({
      model: "gpt-5.6-luna",
      max_tokens: 256,
      messages: [{ role: "user", content: "read README" }],
      tools: [{ name: "read", description: "r", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    });
    expect(r.stop_reason).toBe("tool_use");
    const block = r.content[0];
    expect(block?.type).toBe("tool_use");
    if (block?.type === "tool_use") {
      expect(block.name).toBe("read");
      expect(block.input).toEqual({ path: "/tmp/README.md" });
    }
  });
});

describe("e2e — debug endpoints", () => {
  it("/__health returns ok", async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/__health`);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  it("/__models returns the registered models", async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/__models`);
    const j = (await r.json()) as { models: Array<{ id: string }> };
    expect(j.models.map((m) => m.id)).toContain("gpt-5.6-luna");
  });

  it("/__debug/parse returns a tool_call", async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/__debug/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```' }),
    });
    const j = (await r.json()) as { count: number; tool_calls: Array<{ tool: string }> };
    expect(j.count).toBe(1);
    expect(j.tool_calls[0]?.tool).toBe("exec");
  });
});
