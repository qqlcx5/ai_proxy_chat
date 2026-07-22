import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { GatewayConfig } from "../config/gateway.js";
import { normalize } from "../protocol/normalize.js";
import { denormalize, denormalizeOpenAiChatStream, denormalizeOpenAiResponsesStream } from "../protocol/denormalize.js";
import { buildToolPrompt } from "../engine/prompt-injector.js";
import { callUpstream } from "../engine/upstream-client.js";
import { extractToolCall } from "../engine/parser.js";
import { mountDebugRoutes } from "./debug.js";
import type { InternalRequest, InternalResponse } from "../protocol/types.js";

export function createApp(cfg: GatewayConfig): Hono {
  const app = new Hono();
  mountDebugRoutes(app, cfg);

  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const ir = normalize("openai-chat", body);
    const res = await runEngine(ir, cfg, { signal: c.req.raw.signal });
    if (ir.stream) {
      const chunks = denormalizeOpenAiChatStream(res);
      return new Response(streamSse(chunks), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }
    return c.json(denormalize("openai-chat", res));
  });

  app.post("/v1/messages", async (c) => {
    const body = await c.req.json().catch(() => null);
    const ir = normalize("anthropic", body);
    const res = await runEngine(ir, cfg, { signal: c.req.raw.signal });
    // Anthropic SSE is not implemented; serve non-streaming.
    if (ir.stream) {
      return c.json(denormalize("anthropic", res));
    }
    return c.json(denormalize("anthropic", res));
  });

  app.post("/v1/responses", async (c) => {
    const body = await c.req.json().catch(() => null);
    const ir = normalize("openai-responses", body);
    const res = await runEngine(ir, cfg, { signal: c.req.raw.signal });
    if (ir.stream) {
      const chunks = denormalizeOpenAiResponsesStream(res);
      return new Response(streamSse(chunks), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }
    return c.json(denormalize("openai-responses", res));
  });

  return app;
}

export function startServer(cfg: GatewayConfig): void {
  const app = createApp(cfg);
  serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`[pseudo-tool-calling-gateway] listening on http://${cfg.host}:${info.port}`);
    // eslint-disable-next-line no-console
    console.log(`  upstream: ${cfg.upstream.baseUrl}`);
    // eslint-disable-next-line no-console
    console.log(`  models: ${cfg.models.map((m) => m.id).join(", ")}`);
    // eslint-disable-next-line no-console
    console.log(`  config: ${cfg.configPath}`);
  });
}

async function runEngine(ir: InternalRequest, cfg: GatewayConfig, opts: { signal?: AbortSignal }): Promise<InternalResponse> {
  const toolPrompt = buildToolPrompt(ir.tools);
  let accumulated = "";
  try {
    for await (const chunk of callUpstream(ir, toolPrompt, cfg, opts)) {
      accumulated += chunk.delta;
    }
  } catch (err) {
    return { text: "", toolCalls: [], stopReason: "error", error: err instanceof Error ? err.message : String(err) };
  }
  const toolCall = extractToolCall(accumulated);
  if (toolCall) return { text: "", toolCalls: [toolCall], stopReason: "tool_use" };
  return { text: accumulated, toolCalls: [], stopReason: "end_turn" };
}

function streamSse(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(encoder.encode(ch));
      controller.close();
    },
  });
}
