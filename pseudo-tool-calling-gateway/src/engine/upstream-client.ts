import type { InternalRequest } from "../protocol/types.js";
import { flattenContext } from "./flattener.js";
import type { GatewayConfig } from "../config/gateway.js";

export interface UpstreamChunk {
  delta: string;
  done: boolean;
}

export async function* callUpstream(
  req: InternalRequest,
  injectedPrompt: string,
  cfg: GatewayConfig,
  signal: AbortSignal,
): AsyncGenerator<UpstreamChunk> {
  const upstreamModel = cfg.resolveUpstreamModel(req.model);
  const messages = flattenContext(req, injectedPrompt);

  const payload = {
    model: upstreamModel,
    messages,
    stream: true,
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
  };

  const resp = await fetch(`${cfg.upstream.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.upstream.apiKey ? { authorization: `Bearer ${cfg.upstream.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`upstream ${resp.status}: ${text.slice(0, 500)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = event.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { yield { delta: "", done: true }; return; }
      try {
        const obj = JSON.parse(data);
        const delta = obj?.choices?.[0]?.delta?.content ?? "";
        if (delta) yield { delta, done: false };
      } catch { /* skip */ }
    }
  }
  yield { delta: "", done: true };
}
