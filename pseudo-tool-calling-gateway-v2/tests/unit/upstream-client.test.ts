/**
 * Tests for upstream-client retry/timeout behavior. Boots a tiny mock
 * upstream that fails predictably so we can count attempts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { callUpstream, UpstreamHttpError } from "../../src/engine/upstream-client.js";
import { GatewayConfig } from "../../src/config/gateway.js";
import type { InternalRequest } from "../../src/protocol/types.js";

let server: ReturnType<typeof serve>;
let port = 0;
let attempts = 0;
let route: "ok" | "500" | "429" | "400" = "ok";

beforeAll(async () => {
  const m = new Hono();
  m.post("/chat/completions", async (c) => {
    attempts++;
    if (route === "500") return c.text("boom", 500);
    if (route === "429") return c.text("rate", 429);
    if (route === "400") return c.text("bad", 400);
    const s = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n`));
        controller.enqueue(enc.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });
    return new Response(s, { headers: { "content-type": "text/event-stream" } });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: m.fetch, hostname: "127.0.0.1", port: 0 }, (info) => { port = info.port; resolve(); });
  });
});

afterAll(() => { server?.close(); });

function cfg(): GatewayConfig {
  return Object.assign(new GatewayConfig({
    configPath: "/nonexistent.json",
    modelsPath: "/nonexistent-models.json",
    profilesDir: "/nonexistent-profiles",
  }), { upstream: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "", timeoutSec: 5, retries: 2 } }) as GatewayConfig;
}

function req(): InternalRequest {
  return {
    model: "x", systemPrompt: "", messages: [{ role: "user", text: "hi" }], tools: [], stream: true, protocol: "openai-chat",
  };
}

describe("upstream-client — happy path", () => {
  it("yields deltas on success", async () => {
    route = "ok"; attempts = 0;
    const out: string[] = [];
    for await (const ch of callUpstream(req(), "", cfg())) out.push(ch.delta);
    expect(out.join("")).toBe("hi");
    expect(attempts).toBe(1);
  });
});

describe("upstream-client — retry", () => {
  it("retries on 5xx up to retries+1 attempts, then throws UpstreamHttpError", async () => {
    route = "500"; attempts = 0;
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    await expect(async () => {
      for await (const _ of callUpstream(req(), "", cfg())) { /* noop */ }
    }).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(attempts).toBe(3); // 1 + 2 retries
    sleepSpy.mockRestore();
  });

  it("retries on 429", async () => {
    route = "429"; attempts = 0;
    await expect(async () => {
      for await (const _ of callUpstream(req(), "", cfg())) { /* noop */ }
    }).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(attempts).toBe(3);
  });

  it("does NOT retry on 4xx other than 429", async () => {
    route = "400"; attempts = 0;
    await expect(async () => {
      for await (const _ of callUpstream(req(), "", cfg())) { /* noop */ }
    }).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(attempts).toBe(1);
  });

  it("retries on network error (unreachable host)", async () => {
    const bad = cfg();
    (bad as any).upstream = { baseUrl: "http://127.0.0.1:1", apiKey: "", timeoutSec: 1, retries: 1 };
    await expect(async () => {
      for await (const _ of callUpstream(req(), "", bad)) { /* noop */ }
    }).rejects.toThrow();
  });
});

describe("upstream-client — caller signal", () => {
  it("aborts in-flight call when caller signal fires", async () => {
    route = "ok"; attempts = 0;
    // Use a fresh mock upstream that never responds
    let slowServer: ReturnType<typeof serve> | null = null;
    const slowMock = new Hono();
    slowMock.post("/chat/completions", async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return new Response("");
    });
    const slowPort = await new Promise<number>((resolve) => {
      slowServer = serve({ fetch: slowMock.fetch, hostname: "127.0.0.1", port: 0 }, (info) => { resolve(info.port); });
    });
    try {
      const c = cfg();
      (c as any).upstream = { baseUrl: `http://127.0.0.1:${slowPort}`, apiKey: "", timeoutSec: 30, retries: 0 };
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 100);
      await expect(async () => {
        for await (const _ of callUpstream(req(), "", c, { signal: ctrl.signal })) { /* noop */ }
      }).rejects.toThrow();
    } finally {
      (slowServer as any)?.close?.();
    }
  });
});
