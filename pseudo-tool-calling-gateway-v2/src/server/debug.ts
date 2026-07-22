import type { Hono } from "hono";
import type { GatewayConfig } from "../config/gateway.js";
import { extractToolCall } from "../engine/parser.js";

/**
 * Debug endpoints:
 *   GET  /__health         — liveness + upstream probe
 *   GET  /__models         — registered models + profiles
 *   POST /__debug/parse    — parse a text blob → tool_call
 *
 * All routes are mounted under `app` (the Hono instance). They never
 * reach the upstream or mutate state; safe to expose on the gateway's
 * loopback interface.
 */
export function mountDebugRoutes(app: Hono, cfg: GatewayConfig): void {
  app.get("/__health", (c) =>
    c.json({ ok: true, upstream: cfg.upstream.baseUrl, models: cfg.models.length }),
  );

  app.get("/__models", (c) =>
    c.json({
      models: cfg.models,
      profiles: Object.fromEntries(cfg.profiles),
      config_path: cfg.configPath,
    }),
  );

  app.post("/__debug/parse", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = body?.text ?? "";
    const tc = extractToolCall(text);
    return c.json({
      text,
      count: tc ? 1 : 0,
      tool_calls: tc ? [tc] : [],
    });
  });
}
