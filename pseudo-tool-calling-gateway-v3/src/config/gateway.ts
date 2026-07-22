/**
 * Gateway config — server, upstream, and flattening settings.
 */

export interface GatewayConfig {
  server: {
    host: string;
    port: number;
    logLevel: "debug" | "info" | "warn" | "error";
  };
  upstream: {
    baseUrl: string;
    apiKey: string;
    timeoutSec: number;
    retry: { max: number; backoff: "exponential" };
    stream: boolean;
  };
  flattening: {
    keepRecentTurns: number;
    toolResultTruncate: number;
  };
}

// ─── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: GatewayConfig = {
  server: {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "info",
  },
  upstream: {
    baseUrl: process.env.UPSTREAM_BASE_URL || "http://66.154.117.189:3000/v1",
    apiKey: process.env.UPSTREAM_API_KEY || "",
    timeoutSec: 120,
    retry: { max: 2, backoff: "exponential" },
    stream: true,
  },
  flattening: {
    keepRecentTurns: 3,
    toolResultTruncate: 2000,
  },
};

// ─── Loader ───────────────────────────────────────────────────────────

/**
 * Load config from environment variables with defaults.
 * (TOML parsing omitted for v1 — env vars + defaults suffice.)
 */
export function loadConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };

  // Env var overrides
  if (process.env.GATEWAY_HOST) config.server.host = process.env.GATEWAY_HOST;
  if (process.env.GATEWAY_PORT) config.server.port = parseInt(process.env.GATEWAY_PORT, 10);
  if (process.env.UPSTREAM_BASE_URL) config.upstream.baseUrl = process.env.UPSTREAM_BASE_URL;
  if (process.env.UPSTREAM_API_KEY) config.upstream.apiKey = process.env.UPSTREAM_API_KEY;
  if (process.env.UPSTREAM_TIMEOUT) config.upstream.timeoutSec = parseInt(process.env.UPSTREAM_TIMEOUT, 10);

  return config;
}
