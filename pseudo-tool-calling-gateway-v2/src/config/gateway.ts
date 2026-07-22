import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  timeoutSec: number;
  retries: number;
}

export interface ModelMapping {
  id: string;
  upstreamModel: string;
}

export interface Profile {
  family: string;
  injectionMode: "always" | "when_tools_present" | "never";
  maxHistoryRounds: number;
  truncateChars: number;
}

export class GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly upstream: UpstreamConfig;
  readonly models: ModelMapping[];
  readonly profiles: Map<string, Profile>;
  readonly configPath: string;

  constructor(opts: { configPath?: string; modelsPath?: string; profilesDir?: string } = {}) {
    const root = projectRoot();
    this.configPath = opts.configPath ?? join(root, "config", "gateway.json");

    // Layered loading: defaults < JSON < env
    const fileCfg = loadJson(this.configPath) as Partial<{
      host: string;
      port: number;
      log_level: string;
      upstream: { base_url?: string; api_key?: string; timeout_sec?: number; retries?: number };
    }> | null;

    this.host = process.env.GATEWAY_HOST ?? fileCfg?.host ?? "127.0.0.1";
    this.port = Number(process.env.GATEWAY_PORT ?? fileCfg?.port ?? 8787);
    this.logLevel = process.env.GATEWAY_LOG_LEVEL ?? fileCfg?.log_level ?? "info";

    const fileUp = fileCfg?.upstream ?? {};
    this.upstream = {
      baseUrl: expandEnv(process.env.UPSTREAM_BASE_URL ?? fileUp.base_url ?? "http://66.154.117.189:3000/v1").replace(/\/$/, ""),
      apiKey:  expandEnv(process.env.UPSTREAM_API_KEY ?? fileUp.api_key ?? ""),
      timeoutSec: Number(process.env.UPSTREAM_TIMEOUT_SEC ?? fileUp.timeout_sec ?? 120),
      retries:    Number(process.env.UPSTREAM_RETRIES    ?? fileUp.retries     ?? 2),
    };

    this.models = loadModels(opts.modelsPath ?? join(root, "config", "models.json"));
    this.profiles = loadProfiles(opts.profilesDir ?? join(root, "profiles"));
  }

  resolveUpstreamModel(requestedId: string): string {
    const found = this.models.find((m) => m.id === requestedId);
    return found ? found.upstreamModel : requestedId;
  }
}

function projectRoot(): string {
  // src/config/gateway.ts -> project root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

function loadJson(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Expand ${VAR} and ${VAR:-default} placeholders in a string.
 * Unknown vars (no default) expand to "".
 */
export function expandEnv(input: string): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_, name, def) => {
    if (process.env[name] != null && process.env[name] !== "") return process.env[name]!;
    return def ?? "";
  });
}

function loadModels(path: string): ModelMapping[] {
  // Env override (GATEWAY_MODELS) takes precedence; used in tests.
  if (process.env.GATEWAY_MODELS) {
    return process.env.GATEWAY_MODELS.split(",").map((p) => p.trim()).filter(Boolean).map((pair) => {
      const [id, up] = pair.split(":");
      return { id: id!.trim(), upstreamModel: (up ?? id!).trim() };
    });
  }
  const arr = loadJson(path) as ModelMapping[] | null;
  if (Array.isArray(arr)) return arr;
  return [
    { id: "gpt-5.6-luna", upstreamModel: "gpt-5.6-luna-¥40/1M" },
    { id: "gpt-5.6-sol",  upstreamModel: "gpt-5.6-sol-¥217/1M" },
    { id: "gpt-5.5",      upstreamModel: "gpt-5.5-107¥/1M" },
  ];
}

function loadProfiles(dir: string): Map<string, Profile> {
  const out = new Map<string, Profile>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const raw = loadJson(join(dir, name)) as Profile | null;
    if (raw && typeof raw.family === "string") out.set(raw.family, raw);
  }
  return out;
}
