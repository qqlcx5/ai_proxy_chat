export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  timeoutSec: number;
}

export interface ModelMapping {
  id: string;
  upstreamModel: string;
}

export class GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly upstream: UpstreamConfig;
  readonly models: ModelMapping[];

  constructor() {
    this.host = process.env.GATEWAY_HOST ?? "127.0.0.1";
    this.port = Number(process.env.GATEWAY_PORT ?? "8787");
    this.logLevel = process.env.GATEWAY_LOG_LEVEL ?? "info";
    this.upstream = {
      baseUrl: (process.env.UPSTREAM_BASE_URL ?? "http://66.154.117.189:3000/v1").replace(/\/$/, ""),
      apiKey: process.env.UPSTREAM_API_KEY ?? "",
      timeoutSec: Number(process.env.UPSTREAM_TIMEOUT_SEC ?? "120"),
    };
    this.models = loadModels();
  }

  resolveUpstreamModel(requestedId: string): string {
    const found = this.models.find((m) => m.id === requestedId);
    return found ? found.upstreamModel : requestedId;
  }
}

function loadModels(): ModelMapping[] {
  const envModels = process.env.GATEWAY_MODELS;
  if (envModels) {
    return envModels.split(",").map((p) => p.trim()).filter(Boolean).map((pair) => {
      const [id, up] = pair.split(":");
      return { id: id!.trim(), upstreamModel: (up ?? id!).trim() };
    });
  }
  return [
    { id: "gpt-5.6-luna", upstreamModel: "gpt-5.6-luna-¥40/1M" },
    { id: "gpt-5.6-sol", upstreamModel: "gpt-5.6-sol-¥217/1M" },
    { id: "gpt-5.5", upstreamModel: "gpt-5.5-107¥/1M" },
  ];
}
