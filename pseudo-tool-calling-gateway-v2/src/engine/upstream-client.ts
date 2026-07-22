import type { InternalRequest } from "../protocol/types.js";
import { flattenContext } from "./flattener.js";
import type { GatewayConfig } from "../config/gateway.js";

export interface UpstreamChunk {
  delta: string;
  done: boolean;
}

export interface CallUpstreamOptions {
  signal?: AbortSignal;
  /** Override retry attempts; defaults to cfg.upstream.retries. */
  retries?: number;
  /** Override per-attempt timeout (ms); defaults to cfg.upstream.timeoutSec * 1000. */
  timeoutMs?: number;
}

const RETRY_BACKOFF_MS = [0, 400, 1000]; // first attempt + 2 retries with exponential backoff

/**
 * Stream the upstream LLM. Accumulates nothing — each yielded delta is
 * forwarded to the parser. Implements:
 *   - Per-attempt timeout (AbortController + setTimeout)
 *   - Retry on transient errors (network, 5xx, 429) with exponential backoff
 *   - Non-retryable: 4xx other than 429
 *
 * The caller's `signal` is honored: it aborts the in-flight fetch AND
 * skips remaining retries.
 */
export async function* callUpstream(
  req: InternalRequest,
  injectedPrompt: string,
  cfg: GatewayConfig,
  opts: CallUpstreamOptions = {},
): AsyncGenerator<UpstreamChunk> {
  const retries = opts.retries ?? cfg.upstream.retries;
  const timeoutMs = opts.timeoutMs ?? cfg.upstream.timeoutSec * 1000;

  const upstreamModel = cfg.resolveUpstreamModel(req.model);
  const messages = flattenContext(req, injectedPrompt);

  const payload = {
    model: upstreamModel,
    messages,
    stream: true,
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS.at(-1)!;
    if (backoff > 0) await sleep(backoff, opts.signal);

    // Per-attempt controller chains caller signal + our timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`upstream timeout after ${timeoutMs}ms`)), timeoutMs);
    const onCallerAbort = () => ctrl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const generator = streamOnce(payload, cfg, ctrl.signal);
      for await (const chunk of generator) {
        // Reset timer between chunks so a slow stream isn't killed.
        clearTimeout(timer);
        timer.refresh();
        yield chunk;
      }
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
      return; // success
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
      lastError = err;

      if (opts.signal?.aborted) throw err; // caller-driven abort: do not retry
      if (!isRetryable(err) || attempt === retries) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function* streamOnce(
  payload: unknown,
  cfg: GatewayConfig,
  signal: AbortSignal,
): AsyncGenerator<UpstreamChunk> {
  const resp = await fetch(`${cfg.upstream.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.upstream.apiKey ? { authorization: `Bearer ${cfg.upstream.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new UpstreamHttpError(resp.status, text.slice(0, 500));
    (err as any).status = resp.status;
    throw err;
  }
  if (!resp.body) throw new UpstreamHttpError(0, "no response body");

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
      } catch { /* skip malformed frame */ }
    }
  }
  yield { delta: "", done: true };
}

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`upstream ${status}: ${body}`);
    this.status = status;
    this.body = body;
    this.name = "UpstreamHttpError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamHttpError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false; // 4xx other than 429 is a client error, don't retry
  }
  // network errors / aborts / timeouts are retryable
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(signal?.reason); };
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
