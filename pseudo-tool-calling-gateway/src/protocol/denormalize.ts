import type { InternalResponse, ParsedToolCall, Protocol } from "./types.js";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

function argsString(tc: ParsedToolCall): string {
  try { return JSON.stringify(tc.parameters); } catch { return "{}"; }
}

// --- OpenAI Chat ---
export function denormalizeOpenAiChat(res: InternalResponse): unknown {
  if (res.toolCalls.length > 0) {
    const toolCalls = res.toolCalls.map((tc) => ({
      id: nextId("call"), type: "function",
      function: { name: tc.tool, arguments: argsString(tc) },
    }));
    return {
      id: nextId("chatcmpl"), object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: res.text || null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  return {
    id: nextId("chatcmpl"), object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: res.text },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function denormalizeOpenAiChatStream(res: InternalResponse): string[] {
  const id = nextId("chatcmpl");
  const chunks: string[] = [];
  chunks.push(sseData({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
  if (res.toolCalls.length > 0) {
    res.toolCalls.forEach((tc, i) => {
      chunks.push(sseData({
        id, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: nextId("call"), type: "function", function: { name: tc.tool, arguments: argsString(tc) } }] }, finish_reason: null }],
      }));
    });
    chunks.push(sseData({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
  } else {
    if (res.text) chunks.push(sseData({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: res.text }, finish_reason: null }] }));
    chunks.push(sseData({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  }
  chunks.push("[DONE]");
  return chunks;
}

// --- Anthropic ---
export function denormalizeAnthropic(res: InternalResponse): unknown {
  if (res.toolCalls.length > 0) {
    return {
      id: nextId("msg"), type: "message", role: "assistant",
      content: res.toolCalls.map((tc) => ({ type: "tool_use", id: nextId("toolu"), name: tc.tool, input: tc.parameters })),
      stop_reason: "tool_use",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  return {
    id: nextId("msg"), type: "message", role: "assistant",
    content: [{ type: "text", text: res.text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** Anthropic Messages streaming SSE events. */
export function denormalizeAnthropicStream(res: InternalResponse): string[] {
  const msgId = nextId("msg");
  const chunks: string[] = [];

  // 1. message_start
  chunks.push(sseEvent("message_start", {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", content: [], model: "", stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));

  let blockIndex = 0;
  if (res.toolCalls.length > 0) {
    for (const tc of res.toolCalls) {
      const toolUseId = nextId("toolu");
      // tool_use block: start → partial_json deltas → stop
      chunks.push(sseEvent("content_block_start", {
        type: "content_block_start", index: blockIndex,
        content_block: { type: "tool_use", id: toolUseId, name: tc.tool, input: {} },
      }));
      chunks.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index: blockIndex,
        delta: { type: "input_json_delta", partial_json: argsString(tc) },
      }));
      chunks.push(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
      blockIndex++;
    }
  } else {
    // text block: start → text_delta → stop
    chunks.push(sseEvent("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: { type: "text", text: "" },
    }));
    if (res.text) {
      chunks.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index: blockIndex,
        delta: { type: "text_delta", text: res.text },
      }));
    }
    chunks.push(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
  }

  // 2. message_delta with stop_reason
  chunks.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: res.toolCalls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  }));
  chunks.push(sseEvent("message_stop", { type: "message_stop" }));
  return chunks;
}

// --- OpenAI Responses ---
export function denormalizeOpenAiResponses(res: InternalResponse): unknown {
  const output: unknown[] = [];
  if (res.text) output.push({ type: "message", id: nextId("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: res.text }] });
  for (const tc of res.toolCalls) {
    output.push({ type: "function_call", id: nextId("fc"), call_id: nextId("call"), name: tc.tool, arguments: argsString(tc), status: "completed" });
  }
  return {
    id: nextId("resp"), object: "response", status: "completed",
    output,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/** OpenAI Responses streaming SSE events. */
export function denormalizeOpenAiResponsesStream(res: InternalResponse): string[] {
  const respId = nextId("resp");
  const chunks: string[] = [];

  const base = { id: respId, object: "response", status: "in_progress", output: [], usage: null };
  chunks.push(sseEvent("response.created", { type: "response.created", response: base }));

  let itemIndex = 0;
  const finalOutput: unknown[] = [];
  if (res.text) {
    const msgId = nextId("msg");
    chunks.push(sseEvent("response.output_item.added", {
      type: "response.output_item.added", output_index: itemIndex,
      item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] },
    }));
    chunks.push(sseEvent("response.content_part.added", {
      type: "response.content_part.added", output_index: itemIndex, content_index: 0,
      part: { type: "output_text", text: "" },
    }));
    chunks.push(sseEvent("response.output_text.delta", {
      type: "response.output_text.delta", output_index: itemIndex, content_index: 0, delta: res.text,
    }));
    chunks.push(sseEvent("response.output_text.done", {
      type: "response.output_text.done", output_index: itemIndex, content_index: 0, text: res.text,
    }));
    chunks.push(sseEvent("response.content_part.done", {
      type: "response.content_part.done", output_index: itemIndex, content_index: 0, part: { type: "output_text", text: res.text },
    }));
    const doneItem = { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text: res.text }] };
    chunks.push(sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: itemIndex, item: doneItem }));
    finalOutput.push(doneItem);
    itemIndex++;
  }

  for (const tc of res.toolCalls) {
    const fcId = nextId("fc");
    const callId = nextId("call");
    chunks.push(sseEvent("response.output_item.added", {
      type: "response.output_item.added", output_index: itemIndex,
      item: { type: "function_call", id: fcId, call_id: callId, name: tc.tool, arguments: "", status: "in_progress" },
    }));
    chunks.push(sseEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta", output_index: itemIndex, delta: argsString(tc),
    }));
    chunks.push(sseEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done", output_index: itemIndex, arguments: argsString(tc),
    }));
    const doneItem = { type: "function_call", id: fcId, call_id: callId, name: tc.tool, arguments: argsString(tc), status: "completed" };
    chunks.push(sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: itemIndex, item: doneItem }));
    finalOutput.push(doneItem);
    itemIndex++;
  }

  chunks.push(sseEvent("response.completed", {
    type: "response.completed",
    response: { id: respId, object: "response", status: "completed", output: finalOutput, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  }));
  return chunks;
}

export function denormalize(protocol: Protocol, res: InternalResponse): unknown {
  switch (protocol) {
    case "anthropic": return denormalizeAnthropic(res);
    case "openai-chat": return denormalizeOpenAiChat(res);
    case "openai-responses": return denormalizeOpenAiResponses(res);
  }
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** SSE event with an explicit `event:` line (Anthropic / OpenAI-Responses style). */
function sseEvent(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}
