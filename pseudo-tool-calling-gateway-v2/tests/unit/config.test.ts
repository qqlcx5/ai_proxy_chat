import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayConfig } from "../../src/config/gateway.js";

let tmp: string;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ptcg-cfg-"));
  envSnapshot = { ...process.env };
  // clear any override env
  delete process.env.UPSTREAM_BASE_URL;
  delete process.env.UPSTREAM_API_KEY;
  delete process.env.UPSTREAM_TIMEOUT_SEC;
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.GATEWAY_HOST;
  delete process.env.GATEWAY_PORT;
  delete process.env.GATEWAY_LOG_LEVEL;
  delete process.env.GATEWAY_MODELS;
});

afterEach(() => {
  process.env = envSnapshot;
});

describe("GatewayConfig — JSON loading", () => {
  it("loads host/port from gateway.json when env is silent", () => {
    writeFileSync(join(tmp, "gateway.json"), JSON.stringify({
      host: "0.0.0.0",
      port: 9999,
      log_level: "debug",
      upstream: { base_url: "http://up.example/v1", api_key: "${MISSING_KEY:-fallback}", timeout_sec: 60, retries: 5 },
    }));
    const cfg = new GatewayConfig({ configPath: join(tmp, "gateway.json"), modelsPath: join(tmp, "models.json"), profilesDir: join(tmp, "profiles") });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(9999);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.upstream.baseUrl).toBe("http://up.example/v1");
    expect(cfg.upstream.apiKey).toBe("fallback");
    expect(cfg.upstream.timeoutSec).toBe(60);
    expect(cfg.upstream.retries).toBe(5);
  });

  it("expands ${ENV_VAR} in api_key from JSON", () => {
    process.env.REAL_KEY = "sk-12345";
    writeFileSync(join(tmp, "gateway.json"), JSON.stringify({
      upstream: { base_url: "http://u", api_key: "${REAL_KEY}" },
    }));
    const cfg = new GatewayConfig({ configPath: join(tmp, "gateway.json"), modelsPath: join(tmp, "models.json"), profilesDir: join(tmp, "profiles") });
    expect(cfg.upstream.apiKey).toBe("sk-12345");
  });

  it("env overrides JSON", () => {
    process.env.GATEWAY_PORT = "12345";
    writeFileSync(join(tmp, "gateway.json"), JSON.stringify({ port: 9999 }));
    const cfg = new GatewayConfig({ configPath: join(tmp, "gateway.json"), modelsPath: join(tmp, "models.json"), profilesDir: join(tmp, "profiles") });
    expect(cfg.port).toBe(12345);
  });

  it("loads models from models.json", () => {
    writeFileSync(join(tmp, "models.json"), JSON.stringify([
      { id: "m1", upstreamModel: "u1" },
      { id: "m2", upstreamModel: "u2" },
    ]));
    const cfg = new GatewayConfig({ configPath: join(tmp, "gateway.json"), modelsPath: join(tmp, "models.json"), profilesDir: join(tmp, "profiles") });
    expect(cfg.models).toEqual([
      { id: "m1", upstreamModel: "u1" },
      { id: "m2", upstreamModel: "u2" },
    ]);
  });

  it("GATEWAY_MODELS env overrides models.json", () => {
    writeFileSync(join(tmp, "models.json"), JSON.stringify([{ id: "a", upstreamModel: "b" }]));
    process.env.GATEWAY_MODELS = "x:y,z";
    const cfg = new GatewayConfig({ configPath: join(tmp, "gateway.json"), modelsPath: join(tmp, "models.json"), profilesDir: join(tmp, "profiles") });
    expect(cfg.models).toEqual([{ id: "x", upstreamModel: "y" }, { id: "z", upstreamModel: "z" }]);
  });

  it("loads profiles keyed by family", () => {
    const profDir = join(tmp, "profiles");
    mkdirSync(profDir);
    writeFileSync(join(profDir, "gpt.json"), JSON.stringify({ family: "gpt", injectionMode: "always", maxHistoryRounds: 6, truncateChars: 2000 }));
    writeFileSync(join(profDir, "claude.json"), JSON.stringify({ family: "claude", injectionMode: "never", maxHistoryRounds: 10, truncateChars: 4000 }));
    writeFileSync(join(profDir, "README.md"), "ignored");
    const cfg = new GatewayConfig({ configPath: join(tmp, "gateway.json"), modelsPath: join(tmp, "models.json"), profilesDir: profDir });
    expect(cfg.profiles.size).toBe(2);
    expect(cfg.profiles.get("gpt")?.truncateChars).toBe(2000);
    expect(cfg.profiles.get("claude")?.injectionMode).toBe("never");
  });

  it("falls back to hardcoded defaults when no config files exist", () => {
    const cfg = new GatewayConfig({ configPath: join(tmp, "none.json"), modelsPath: join(tmp, "none-models.json"), profilesDir: join(tmp, "none-profiles") });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(8787);
    expect(cfg.models.length).toBeGreaterThan(0);
    expect(cfg.profiles.size).toBe(0);
  });
});

describe("GatewayConfig.resolveUpstreamModel", () => {
  it("returns upstreamModel when id is registered", () => {
    const cfg = new GatewayConfig({ configPath: join(tmp, "none.json"), modelsPath: join(tmp, "none-models.json"), profilesDir: join(tmp, "none-profiles") });
    const id = cfg.models[0]!.id;
    expect(cfg.resolveUpstreamModel(id)).toBe(cfg.models[0]!.upstreamModel);
  });

  it("returns the input as-is when id is unknown", () => {
    const cfg = new GatewayConfig({ configPath: join(tmp, "none.json"), modelsPath: join(tmp, "none-models.json"), profilesDir: join(tmp, "none-profiles") });
    expect(cfg.resolveUpstreamModel("unknown-model")).toBe("unknown-model");
  });
});
