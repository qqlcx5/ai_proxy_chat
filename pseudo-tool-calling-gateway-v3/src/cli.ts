#!/usr/bin/env node
/**
 * pseudo-tool-calling-gateway — CLI entry point.
 *
 * Usage:
 *   pseudo-tool-calling-gateway [start|status]
 *   gateway start --port 8787 --host 127.0.0.1
 *
 * Environment variables:
 *   UPSTREAM_BASE_URL  — reverse-proxy API base URL
 *   UPSTREAM_API_KEY   — API key for upstream
 *   GATEWAY_HOST       — listen host (default 127.0.0.1)
 *   GATEWAY_PORT       — listen port (default 8787)
 */

import { serve } from "@hono/node-server";
import { createApp } from "./server/router.js";
import { loadConfig } from "./config/gateway.js";
import { ModelRegistry, DEFAULT_MODELS, DEFAULT_PROFILES } from "./config/models.js";

const args = process.argv.slice(2);
const command = args[0] || "start";

function showHelp() {
  console.log(`
pseudo-tool-calling-gateway v1.0.0

Usage:
  gateway start [--port PORT] [--host HOST] [--upstream URL] [--api-key KEY]
  gateway status
  gateway --help

Options:
  --port PORT         Listen port (default: 8787, env: GATEWAY_PORT)
  --host HOST         Listen host (default: 127.0.0.1, env: GATEWAY_HOST)
  --upstream URL      Upstream API base URL (env: UPSTREAM_BASE_URL)
  --api-key KEY       Upstream API key (env: UPSTREAM_API_KEY)
  --timeout SEC       Upstream timeout in seconds (default: 120)

Endpoints:
  POST /v1/chat/completions   OpenAI Chat Completions
  POST /v1/responses          OpenAI Responses
  POST /v1/messages           Anthropic Messages
  GET  /__health              Health check
  GET  /__models              List registered models
  POST /__debug/parse         Debug tool call parser
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2).replace(/-./g, (_, i: number) =>
        String.fromCharCode(i + 1).toUpperCase(),
      );
      opts[key] = args[i + 1] || "true";
      i++;
    }
  }
  return opts;
}

async function main() {
  if (command === "--help" || command === "-h" || command === "help") {
    showHelp();
    process.exit(0);
  }

  if (command === "status") {
    // Check if gateway is running
    try {
      const config = loadConfig();
      const resp = await fetch(`http://${config.server.host}:${config.server.port}/__health`);
      if (resp.ok) {
        const data = await resp.json();
        console.log("Gateway is running:", JSON.stringify(data, null, 2));
      } else {
        console.log("Gateway returned error:", resp.status);
      }
    } catch {
      console.log("Gateway is not running.");
    }
    process.exit(0);
  }

  if (command !== "start" && command !== "--start") {
    showHelp();
    process.exit(1);
  }

  // Parse CLI args for overrides
  const opts = parseArgs(args.slice(1));
  const config = loadConfig({
    server: {
      host: opts.host || process.env.GATEWAY_HOST || "127.0.0.1",
      port: parseInt(opts.port || process.env.GATEWAY_PORT || "8787", 10),
      logLevel: "info",
    },
    upstream: {
      baseUrl: opts.upstream || process.env.UPSTREAM_BASE_URL || "http://66.154.117.189:3000/v1",
      apiKey: opts.apiKey || process.env.UPSTREAM_API_KEY || "",
      timeoutSec: parseInt(opts.timeout || "120", 10),
      retry: { max: 2, backoff: "exponential" },
      stream: true,
    },
    flattening: {
      keepRecentTurns: 3,
      toolResultTruncate: 2000,
    },
  });

  const registry = new ModelRegistry(DEFAULT_MODELS, DEFAULT_PROFILES);
  const app = createApp(config, registry);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   pseudo-tool-calling-gateway v1.0.0                         ║
║   Listening on http://${config.server.host}:${config.server.port}                        ║
╠══════════════════════════════════════════════════════════════╣
║   Upstream:  ${config.upstream.baseUrl.padEnd(46)} ║
║   Models:    ${registry.listModels().map(m => m.id).join(", ").padEnd(46)} ║
║   Endpoints:                                                 ║
║     POST /v1/chat/completions   (OpenAI Chat)                ║
║     POST /v1/responses          (OpenAI Responses)           ║
║     POST /v1/messages           (Anthropic Messages)         ║
║     GET  /__health              (Health check)               ║
║     GET  /__models              (Model list)                 ║
║     POST /__debug/parse         (Parser debug)               ║
╚══════════════════════════════════════════════════════════════╝
`);

  serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
