/**
 * Engine — orchestrates the full request pipeline:
 *   normalize → flatten → inject prompt → call upstream → parse → denormalize
 */

import type { InternalRequest, InternalResponse } from "../protocol/types.js";
import { buildFlattenedPrompt } from "./prompt-injector.js";
import { callUpstream, type UpstreamConfig } from "./upstream-client.js";

export interface EngineOptions {
  keepRecentTurns: number;
  toolResultTruncate: number;
}

export async function processRequest(
  req: InternalRequest,
  upstreamModel: string,
  upstreamConfig: UpstreamConfig,
  engineOptions: EngineOptions,
): Promise<InternalResponse> {
  // 1. Flatten context (inject tool prompt + flatten messages)
  const flattened = buildFlattenedPrompt(req, {
    keepRecentTurns: engineOptions.keepRecentTurns,
    toolResultTruncate: engineOptions.toolResultTruncate,
  });

  console.log(
    `[engine] protocol=${req._protocol} model=${req.model} tools=${req.tools.length} ` +
      `prompt_len=${flattened.system.length + flattened.userMessage.length} ` +
      `messages=${req.messages.length} stream=${req.stream}`,
  );

  // 2. Call upstream with the mapped model name
  const upstreamReq: InternalRequest = {
    ...req,
    model: upstreamModel, // Map to upstream model name
  };

  // 3. Call upstream API
  const response = await callUpstream(upstreamReq, flattened, upstreamConfig);

  // 4. Return IR response (parser already ran inside callUpstream)
  return response;
}
