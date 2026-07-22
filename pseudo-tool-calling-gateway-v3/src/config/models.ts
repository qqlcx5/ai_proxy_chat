/**
 * Model registry — maps gateway model IDs to upstream model names + profiles.
 */

export interface ModelConfig {
  id: string;
  profile: string;
  upstreamModel: string;
}

export interface ProfileConfig {
  apiFamily: "en" | "cn";
  outputFormat: "fenced_tool_json" | "bare_json" | "xml";
  injectMode: "always" | "keyword" | "never";
  strict: boolean;
  extraInstructions: string;
  quirks: {
    addsTrailingText: boolean;
    dropsClosingBrace: boolean;
  };
}

// ─── Default config ───────────────────────────────────────────────────

export const DEFAULT_MODELS: ModelConfig[] = [
  { id: "gpt-5.6-luna", profile: "gpt", upstreamModel: "gpt-5.6-luna-¥40/1M" },
  { id: "gpt-5.6-sol", profile: "gpt", upstreamModel: "gpt-5.6-sol-¥217/1M" },
  { id: "gpt-5.5", profile: "gpt", upstreamModel: "gpt-5.5-107¥/1M" },
];

export const DEFAULT_PROFILES: Record<string, ProfileConfig> = {
  gpt: {
    apiFamily: "en",
    outputFormat: "fenced_tool_json",
    injectMode: "always",
    strict: false,
    extraInstructions: "",
    quirks: {
      addsTrailingText: true,
      dropsClosingBrace: false,
    },
  },
};

// ─── Registry ─────────────────────────────────────────────────────────

export class ModelRegistry {
  private models = new Map<string, ModelConfig>();
  private profiles = new Map<string, ProfileConfig>();

  constructor(
    models: ModelConfig[] = DEFAULT_MODELS,
    profiles: Record<string, ProfileConfig> = DEFAULT_PROFILES,
  ) {
    for (const m of models) {
      this.models.set(m.id, m);
    }
    for (const [name, p] of Object.entries(profiles)) {
      this.profiles.set(name, p);
    }
  }

  getModel(id: string): ModelConfig | undefined {
    return this.models.get(id);
  }

  getProfile(name: string): ProfileConfig | undefined {
    return this.profiles.get(name);
  }

  getProfileForModel(id: string): ProfileConfig | undefined {
    const model = this.models.get(id);
    if (!model) return undefined;
    return this.profiles.get(model.profile);
  }

  listModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  listModelsWithProfiles(): Array<ModelConfig & { profileConfig?: ProfileConfig }> {
    return this.listModels().map((m) => ({
      ...m,
      profileConfig: this.profiles.get(m.profile),
    }));
  }
}
