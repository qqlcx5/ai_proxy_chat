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

export function denormalizeOpenAiResponsesStream(res: InternalResponse): string[] {
  const respId = nextId("resp");
  const chunks: string[] = [];
  chunks.push(sseData({ type: "response.created", response: { id: respId, object: "response", status: "in_progress", output: [] } }));
  if (res.text) {
    const msgId = nextId("msg");
    chunks.push(sseData({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] } }));
    chunks.push(sseData({ type: "response.content_part.added", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }));
    chunks.push(sseData({ type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta: res.text }));
    chunks.push(sseData({ type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text: res.text }));
    chunks.push(sseData({ type: "response.content_part.done", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: res.text } }));
    chunks.push(sseData({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text: res.text }] } }));
  }
  res.toolCalls.forEach((tc, i) => {
    const fcId = nextId("fc");
    const outIdx = res.text ? 1 + i : i;
    chunks.push(sseData({ type: "response.output_item.added", output_index: outIdx, item: { type: "function_call", id: fcId, call_id: nextId("call"), name: tc.tool, arguments: "", status: "in_progress" } }));
    chunks.push(sseData({ type: "response.function_call_arguments.delta", item_id: fcId, output_index: outIdx, delta: argsString(tc) }));
    chunks.push(sseData({ type: "response.function_call_arguments.done", item_id: fcId, output_index: outIdx, arguments: argsString(tc) }));
    chunks.push(sseData({ type: "response.output_item.done", output_index: outIdx, item: { type: "function_call", id: fcId, call_id: nextId("call"), name: tc.tool, arguments: argsString(tc), status: "completed" } }));
  });
  chunks.push(sseData({ type: "response.completed", response: denormalizeOpenAiResponses(res) }));
  chunks.push("[DONE]");
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
