/**
 * Denormalize InternalResponse back to each protocol's native format.
 *
 * IR → Anthropic Messages response
 * IR → OpenAI Chat Completions response
 * IR → OpenAI Responses response
 */

import type { InternalResponse, Protocol, ParsedToolCall } from "./types.js";

function genToolId(): string {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Anthropic ────────────────────────────────────────────────────────

export function denormalizeAnthropic(
  resp: InternalResponse,
  model: string,
): Record<string, unknown> {
  const content: unknown[] = [];

  if (resp.text && resp.toolCalls.length === 0) {
    content.push({ type: "text", text: resp.text });
  }

  for (const tc of resp.toolCalls) {
    content.push({
      type: "tool_use",
      id: genToolId(),
      name: tc.tool,
      input: tc.parameters,
    });
  }

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: resp.toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input ?? 0,
      output_tokens: resp.usage?.output ?? 0,
    },
  };
}

// ─── OpenAI Chat Completions ──────────────────────────────────────────

export function denormalizeOpenAIChat(
  resp: InternalResponse,
  model: string,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
  };

  if (resp.toolCalls.length > 0) {
    message.content = resp.text || null;
    message.tool_calls = resp.toolCalls.map((tc: ParsedToolCall) => ({
      id: genToolId(),
      type: "function",
      function: {
        name: tc.tool,
        arguments: JSON.stringify(tc.parameters),
      },
    }));
  } else {
    message.content = resp.text || "";
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: resp.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: resp.usage?.input ?? 0,
      completion_tokens: resp.usage?.output ?? 0,
      total_tokens: (resp.usage?.input ?? 0) + (resp.usage?.output ?? 0),
    },
  };
}

// ─── OpenAI Responses ─────────────────────────────────────────────────

export function denormalizeOpenAIResponses(
  resp: InternalResponse,
  model: string,
): Record<string, unknown> {
  const output: unknown[] = [];

  if (resp.text && resp.toolCalls.length === 0) {
    output.push({
      type: "message",
      id: `msg_${Date.now()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: resp.text }],
    });
  }

  for (const tc of resp.toolCalls) {
    const id = genToolId();
    output.push({
      type: "function_call",
      id,
      call_id: id,
      name: tc.tool,
      arguments: JSON.stringify(tc.parameters),
      status: "completed",
    });
  }

  return {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output,
    status: "completed",
    usage: {
      input_tokens: resp.usage?.input ?? 0,
      output_tokens: resp.usage?.output ?? 0,
      total_tokens: (resp.usage?.input ?? 0) + (resp.usage?.output ?? 0),
    },
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────

export function denormalize(
  protocol: Protocol,
  resp: InternalResponse,
  model: string,
): Record<string, unknown> {
  switch (protocol) {
    case "anthropic":
      return denormalizeAnthropic(resp, model);
    case "openai-chat":
      return denormalizeOpenAIChat(resp, model);
    case "openai-responses":
      return denormalizeOpenAIResponses(resp, model);
  }
}

// ─── SSE event builders ───────────────────────────────────────────────

/**
 * Build SSE events for streaming responses.
 * v1 uses Strategy A: buffer complete response, emit at once as a single chunk.
 */

export function buildAnthropicSSE(resp: InternalResponse, model: string): string[] {
  const events: string[] = [];
  const msgId = `msg_${Date.now()}`;

  // message_start
  events.push(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: resp.usage?.input ?? 0, output_tokens: 0 },
      },
    })}`,
  );

  if (resp.toolCalls.length > 0) {
    // Emit tool_use blocks
    let index = 0;
    for (const tc of resp.toolCalls) {
      const toolId = genToolId();
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: toolId, name: tc.tool, input: {} },
        })}`,
      );
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.parameters) },
        })}`,
      );
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}`,
      );
      index++;
    }
    if (resp.text) {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        })}`,
      );
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: resp.text },
        })}`,
      );
      events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}`,
      );
    }
  } else {
    // Pure text
    events.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
    );
    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: resp.text },
      })}`,
    );
    events.push(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    );
  }

  // message_delta + message_stop
  events.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: resp.toolCalls.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: resp.usage?.output ?? 0 },
    })}`,
  );
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`);

  return events;
}

export function buildOpenAIChatSSE(resp: InternalResponse, model: string): string[] {
  const events: string[] = [];
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (resp.toolCalls.length > 0) {
    const delta: Record<string, unknown> = { role: "assistant" };
    if (resp.text) delta.content = resp.text;
    delta.tool_calls = resp.toolCalls.map((tc, i) => ({
      index: i,
      id: genToolId(),
      type: "function",
      function: { name: tc.tool, arguments: JSON.stringify(tc.parameters) },
    }));
    events.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}`,
    );
  } else {
    events.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: resp.text }, finish_reason: null }],
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}`,
    );
  }

  events.push("data: [DONE]");
  return events;
}

export function buildOpenAIResponsesSSE(resp: InternalResponse, model: string): string[] {
  const events: string[] = [];
  const id = `resp_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  // response.created
  events.push(
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id, object: "response", created_at: created, model, status: "in_progress", output: [] },
    })}`,
  );

  if (resp.toolCalls.length > 0) {
    for (const tc of resp.toolCalls) {
      const callId = genToolId();
      const fcId = `fc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      events.push(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: fcId,
            call_id: callId,
            name: tc.tool,
            arguments: "",
            status: "in_progress",
          },
        })}`,
      );
      events.push(
        `data: ${JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: fcId,
          delta: JSON.stringify(tc.parameters),
        })}`,
      );
      events.push(
        `data: ${JSON.stringify({
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: fcId,
          arguments: JSON.stringify(tc.parameters),
        })}`,
      );
      events.push(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: fcId,
            call_id: callId,
            name: tc.tool,
            arguments: JSON.stringify(tc.parameters),
            status: "completed",
          },
        })}`,
      );
    }
  } else {
    // Text output
    events.push(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: `msg_${Date.now()}`,
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: resp.text,
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text: resp.text,
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: resp.text },
      })}`,
    );
    events.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: `msg_${Date.now()}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: resp.text }],
        },
      })}`,
    );
  }

  // response.completed
  events.push(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        object: "response",
        created_at: created,
        model,
        status: "completed",
        output:
          resp.toolCalls.length > 0
            ? resp.toolCalls.map((tc) => {
                const callId = genToolId();
                return {
                  type: "function_call",
                  id: `fc_${Date.now()}`,
                  call_id: callId,
                  name: tc.tool,
                  arguments: JSON.stringify(tc.parameters),
                  status: "completed",
                };
              })
            : [
                {
                  type: "message",
                  id: `msg_${Date.now()}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: resp.text }],
                },
              ],
        usage: {
          input_tokens: resp.usage?.input ?? 0,
          output_tokens: resp.usage?.output ?? 0,
          total_tokens: (resp.usage?.input ?? 0) + (resp.usage?.output ?? 0),
        },
      },
    })}`,
  );

  return events;
}

export function buildSSE(
  protocol: Protocol,
  resp: InternalResponse,
  model: string,
): string[] {
  switch (protocol) {
    case "anthropic":
      return buildAnthropicSSE(resp, model);
    case "openai-chat":
      return buildOpenAIChatSSE(resp, model);
    case "openai-responses":
      return buildOpenAIResponsesSSE(resp, model);
  }
}
