/**
 * HTTP Server — three protocol routes on a single Hono app.
 *
 * POST /v1/chat/completions  → OpenAI Chat Completions
 * POST /v1/responses         → OpenAI Responses
 * POST /v1/messages          → Anthropic Messages
 *
 * Debug endpoints:
 * GET  /__health             → liveness + upstream check
 * GET  /__models             → registered models + profiles
 * POST /__debug/parse        → parse text, return tool calls
 */

import { Hono } from "hono";
import { normalize } from "../protocol/normalize.js";
import { denormalize, buildSSE } from "../protocol/denormalize.js";
import { processRequest } from "../engine/loop.js";
import { ModelRegistry } from "../config/models.js";
import type { GatewayConfig } from "../config/gateway.js";
import { extractToolCalls, parseWithRepairInfo } from "../engine/parser.js";

export function createApp(config: GatewayConfig, registry: ModelRegistry) {
  const app = new Hono();

  // ─── OpenAI Chat Completions ───────────────────────────────────────

  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json();
    const req = normalize("openai-chat", body);

    const modelCfg = registry.getModel(req.model);
    if (!modelCfg) {
      return c.json({ error: { message: `Model '${req.model}' not registered`, type: "invalid_request_error" } }, 404);
    }

    const profile = registry.getProfile(modelCfg.profile);
    if (profile?.injectMode === "never") {
      // Pass through without tool injection (still strip tools)
    }

    console.log(
      `[request] protocol=openai-chat model=${req.model} tools=${req.tools.length} stream=${req.stream}`,
    );

    try {
      const resp = await processRequest(
        req,
        modelCfg.upstreamModel,
        {
          baseUrl: config.upstream.baseUrl,
          apiKey: config.upstream.apiKey,
          timeoutSec: config.upstream.timeoutSec,
          retry: config.upstream.retry,
          stream: config.upstream.stream,
        },
        {
          keepRecentTurns: config.flattening.keepRecentTurns,
          toolResultTruncate: config.flattening.toolResultTruncate,
        },
      );

      if (req.stream) {
        const events = buildSSE("openai-chat", resp, req.model);
        return new Response(events.join("\n\n") + "\n\n", {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        const result = denormalize("openai-chat", resp, req.model);
        return c.json(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] protocol=openai-chat: ${msg}`);
      return c.json(
        { error: { message: `Gateway error: ${msg}`, type: "server_error" } },
        502,
      );
    }
  });

  // ─── OpenAI Responses ──────────────────────────────────────────────

  app.post("/v1/responses", async (c) => {
    const body = await c.req.json();
    const req = normalize("openai-responses", body);

    const modelCfg = registry.getModel(req.model);
    if (!modelCfg) {
      return c.json(
        { error: { message: `Model '${req.model}' not registered`, type: "invalid_request_error" } },
        404,
      );
    }

    console.log(
      `[request] protocol=openai-responses model=${req.model} tools=${req.tools.length} stream=${req.stream}`,
    );

    try {
      const resp = await processRequest(
        req,
        modelCfg.upstreamModel,
        {
          baseUrl: config.upstream.baseUrl,
          apiKey: config.upstream.apiKey,
          timeoutSec: config.upstream.timeoutSec,
          retry: config.upstream.retry,
          stream: config.upstream.stream,
        },
        {
          keepRecentTurns: config.flattening.keepRecentTurns,
          toolResultTruncate: config.flattening.toolResultTruncate,
        },
      );

      if (req.stream) {
        const events = buildSSE("openai-responses", resp, req.model);
        return new Response(events.join("\n\n") + "\n\n", {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        const result = denormalize("openai-responses", resp, req.model);
        return c.json(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] protocol=openai-responses: ${msg}`);
      return c.json(
        { error: { message: `Gateway error: ${msg}`, type: "server_error" } },
        502,
      );
    }
  });

  // ─── Anthropic Messages ────────────────────────────────────────────

  app.post("/v1/messages", async (c) => {
    const body = await c.req.json();
    const req = normalize("anthropic", body);

    const modelCfg = registry.getModel(req.model);
    if (!modelCfg) {
      return c.json(
        { type: "error", error: { type: "not_found_error", message: `Model '${req.model}' not registered` } },
        404,
      );
    }

    console.log(
      `[request] protocol=anthropic model=${req.model} tools=${req.tools.length} stream=${req.stream}`,
    );

    try {
      const resp = await processRequest(
        req,
        modelCfg.upstreamModel,
        {
          baseUrl: config.upstream.baseUrl,
          apiKey: config.upstream.apiKey,
          timeoutSec: config.upstream.timeoutSec,
          retry: config.upstream.retry,
          stream: config.upstream.stream,
        },
        {
          keepRecentTurns: config.flattening.keepRecentTurns,
          toolResultTruncate: config.flattening.toolResultTruncate,
        },
      );

      if (req.stream) {
        const events = buildSSE("anthropic", resp, req.model);
        return new Response(events.join("\n\n") + "\n\n", {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        const result = denormalize("anthropic", resp, req.model);
        return c.json(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] protocol=anthropic: ${msg}`);
      return c.json(
        { type: "error", error: { type: "api_error", message: `Gateway error: ${msg}` } },
        502,
      );
    }
  });

  // ─── Debug endpoints ───────────────────────────────────────────────

  app.get("/__health", (c) => {
    return c.json({
      status: "ok",
      upstream: config.upstream.baseUrl,
      models: registry.listModels().length,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/__models", (c) => {
    return c.json({
      models: registry.listModelsWithProfiles(),
      profiles: Object.fromEntries(
        registry.listModelsWithProfiles().map((m) => [m.profile, m.profileConfig]),
      ),
    });
  });

  app.post("/__debug/parse", async (c) => {
    const { text } = await c.req.json();
    const { calls, repairUsed } = parseWithRepairInfo(text);
    return c.json({
      toolCalls: calls,
      repairUsed,
      rawLength: text.length,
    });
  });

  return app;
}
