/**
 * Upstream Client — calls the reverse-proxy LLM API.
 *
 * Assumes upstream is OpenAI Chat Completions compatible (POST /v1/chat/completions).
 * Strips all tools fields, sends pure text prompt, handles streaming + retry.
 */

import type { InternalRequest, InternalResponse } from "../protocol/types.js";
import { parseWithRepairInfo } from "./parser.js";

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  timeoutSec: number;
  retry: { max: number; backoff: "exponential" };
  stream: boolean;
}

interface UpstreamMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface UpstreamChunk {
  choices: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Call the upstream API and return an InternalResponse.
 * v1 Strategy A: buffer the full response, parse at the end.
 */
export async function callUpstream(
  req: InternalRequest,
  flattened: { system: string; userMessage: string },
  config: UpstreamConfig,
): Promise<InternalResponse> {
  const messages: UpstreamMessage[] = [];
  if (flattened.system) {
    messages.push({ role: "system", content: flattened.system });
  }
  messages.push({ role: "user", content: flattened.userMessage });

  const body: Record<string, unknown> = {
    model: req.model, // Note: caller must map to upstream model name before calling
    messages,
    stream: config.stream && req.stream,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.retry.max; attempt++) {
    try {
      if (attempt > 0) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await sleep(delayMs);
        console.log(`[upstream] retry attempt ${attempt} after ${delayMs}ms`);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutSec * 1000);

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        // 4xx: don't retry
        if (resp.status >= 400 && resp.status < 500) {
          throw new UpstreamError(
            `upstream ${resp.status}: ${errText}`,
            "client_error",
          );
        }
        // 5xx: retry
        throw new UpstreamError(
          `upstream ${resp.status}: ${errText}`,
          "server_error",
        );
      }

      // Handle streaming vs non-streaming
      if (body.stream) {
        return await handleStreamResponse(resp, req.model);
      } else {
        return await handleJsonResponse(resp, req.model);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry client errors
      if (err instanceof UpstreamError && err.kind === "client_error") {
        throw err;
      }
      // Abort/timeout — retry
      console.log(`[upstream] attempt ${attempt} failed: ${lastError.message}`);
    }
  }

  throw lastError || new Error("upstream failed after retries");
}

async function handleJsonResponse(
  resp: Response,
  model: string,
): Promise<InternalResponse> {
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content || "";
  const usage = data.usage
    ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
    : undefined;

  const { calls, repairUsed } = parseWithRepairInfo(text);

  if (calls.length > 0) {
    console.log(
      `[parse] tool_call=yes count=${calls.length} repair=${repairUsed || "none"}`,
    );
  }

  return {
    text,
    toolCalls: calls,
    stopReason: calls.length > 0 ? "tool_use" : "stop",
    usage,
  };
}

async function handleStreamResponse(
  resp: Response,
  model: string,
): Promise<InternalResponse> {
  // Strategy A: buffer entire response, parse at end
  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("upstream stream: no body reader");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let usage: { input?: number; output?: number } | undefined;
  let ttft = 0;
  const startTime = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const chunk: UpstreamChunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;

          if (delta?.content) {
            if (ttft === 0) ttft = Date.now() - startTime;
            fullText += delta.content;
          }

          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens,
              output: chunk.usage.completion_tokens,
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const totalMs = Date.now() - startTime;
  console.log(
    `[upstream] stream done ttft=${ttft}ms total=${totalMs}ms textLen=${fullText.length}`,
  );

  const { calls, repairUsed } = parseWithRepairInfo(fullText);

  if (calls.length > 0) {
    console.log(
      `[parse] tool_call=yes count=${calls.length} repair=${repairUsed || "none"}`,
    );
  }

  return {
    text: fullText,
    toolCalls: calls,
    stopReason: calls.length > 0 ? "tool_use" : "stop",
    usage,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UpstreamError extends Error {
  kind: "client_error" | "server_error";
  constructor(message: string, kind: "client_error" | "server_error") {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
  }
}
