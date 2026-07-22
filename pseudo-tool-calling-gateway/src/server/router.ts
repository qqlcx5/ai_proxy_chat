import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { GatewayConfig } from "../config/gateway.js";
import { normalize } from "../protocol/normalize.js";
import { denormalize, denormalizeOpenAiChatStream, denormalizeAnthropicStream, denormalizeOpenAiResponsesStream } from "../protocol/denormalize.js";
import { buildToolPrompt } from "../engine/prompt-injector.js";
import { callUpstream } from "../engine/upstream-client.js";
import { extractToolCall } from "../engine/parser.js";
import type { InternalRequest, InternalResponse, Protocol } from "../protocol/types.js";
import { log } from "./logger.js";

export function createApp(cfg: GatewayConfig): Hono {
  const app = new Hono();

  app.get("/__health", (c) => c.json({ ok: true, upstream: cfg.upstream.baseUrl }));
  app.get("/__models", (c) => c.json({ models: cfg.models }));

  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json().catch(() => null);
    let ir: InternalRequest;
    try {
      ir = normalize("openai-chat", body);
    } catch (err) {
      log.warn("normalize_failed", { protocol: "openai-chat", error: String(err) });
      return c.json({ error: { message: String(err) } }, 400);
    }
    const res = await runEngine(ir, cfg, c.req.raw.signal);
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
    let ir: InternalRequest;
    try {
      ir = normalize("anthropic", body);
    } catch (err) {
      log.warn("normalize_failed", { protocol: "anthropic", error: String(err) });
      return c.json({ type: "error", error: { type: "invalid_request_error", message: String(err) } }, 400);
    }
    const res = await runEngine(ir, cfg, c.req.raw.signal);
    if (ir.stream) {
      const chunks = denormalizeAnthropicStream(res);
      return new Response(streamSse(chunks), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }
    return c.json(denormalize("anthropic", res));
  });

  app.post("/v1/responses", async (c) => {
    const body = await c.req.json().catch(() => null);
    let ir: InternalRequest;
    try {
      ir = normalize("openai-responses", body);
    } catch (err) {
      log.warn("normalize_failed", { protocol: "openai-responses", error: String(err) });
      return c.json({ error: { message: String(err) } }, 400);
    }
    const res = await runEngine(ir, cfg, c.req.raw.signal);
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
    log.info("listening", { url: `http://${cfg.host}:${info.port}`, upstream: cfg.upstream.baseUrl, models: cfg.models.map((m) => m.id).join(",") });
  });
}

async function runEngine(ir: InternalRequest, cfg: GatewayConfig, signal: AbortSignal): Promise<InternalResponse> {
  const protocol: Protocol = ir.protocol;
  const toolPrompt = buildToolPrompt(ir.tools);
  const injectTools = toolPrompt.length > 0;
  const t0 = Date.now();

  log.info("request", { protocol, model: ir.model, tools: ir.tools.length, inject: injectTools ? "always" : "never", prompt_len: toolPrompt.length });

  let accumulated = "";
  let upstreamStatus = 0;
  try {
    for await (const chunk of callUpstream(ir, toolPrompt, cfg, signal)) {
      accumulated += chunk.delta;
      if (chunk.done) upstreamStatus = 200;
    }
    upstreamStatus = upstreamStatus || 200;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("upstream_failed", { protocol, error: errMsg, elapsed: Date.now() - t0 });
    return { text: "", toolCalls: [], stopReason: "error", error: errMsg };
  }

  const elapsed = Date.now() - t0;
  log.info("upstream", { protocol, status: upstreamStatus, elapsed_ms: elapsed, output_len: accumulated.length });

  const toolCall = extractToolCall(accumulated);
  if (toolCall) {
    log.info("parse", { protocol, tool_call: "yes", tool: toolCall.tool, args_len: JSON.stringify(toolCall.parameters).length });
    log.info("response", { protocol, stop: "tool_use", emulate: true });
    return { text: "", toolCalls: [toolCall], stopReason: "tool_use" };
  }
  log.info("parse", { protocol, tool_call: "no" });
  log.info("response", { protocol, stop: "end_turn" });
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
