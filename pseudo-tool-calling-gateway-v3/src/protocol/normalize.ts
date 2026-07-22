/**
 * Normalize three upstream protocols into InternalRequest IR.
 *
 * Anthropic Messages → IR
 * OpenAI Chat Completions → IR
 * OpenAI Responses → IR
 */

import type { InternalRequest, NormalizedMessage, NormalizedTool, Protocol } from "./types.js";

// ─── Anthropic Messages ───────────────────────────────────────────────

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

interface AnthropicMessage {
  role: string;
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string }> }
  >;
}

interface AnthropicRequestBody {
  model: string;
  system?: string | Array<{ type: string; text: string }>;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export function normalizeAnthropic(body: AnthropicRequestBody): InternalRequest {
  // System prompt
  let systemPrompt = "";
  if (typeof body.system === "string") {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system.map((s) => s.text || "").join("\n");
  }

  // Messages
  const messages: NormalizedMessage[] = [];
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role === "assistant" ? "assistant" : "user", text: msg.content });
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          messages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            text: block.text,
          });
        } else if (block.type === "tool_use") {
          messages.push({
            role: "assistant",
            text: `[调用工具 ${block.name}(${JSON.stringify(block.input)})]`,
            toolCallId: block.id,
            toolName: block.name,
          });
        } else if (block.type === "tool_result") {
          let resultText = "";
          if (typeof block.content === "string") {
            resultText = block.content;
          } else if (Array.isArray(block.content)) {
            resultText = block.content.map((c) => c.text || "").join("");
          }
          messages.push({
            role: "tool_result",
            text: resultText,
            toolCallId: block.tool_use_id,
          });
        }
      }
    }
  }

  // Tools
  const tools: NormalizedTool[] = (body.tools || []).map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.input_schema as NormalizedTool["inputSchema"],
  }));

  return {
    model: body.model,
    systemPrompt,
    messages,
    tools,
    stream: body.stream ?? false,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    _protocol: "anthropic",
    _raw: body,
  };
}

// ─── OpenAI Chat Completions ──────────────────────────────────────────

interface OpenAIChatTool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters: { type: string; properties?: Record<string, unknown>; required?: string[] };
  };
}

interface OpenAIChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIChatRequestBody {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIChatTool[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  developer_role?: string;
}

export function normalizeOpenAIChat(body: OpenAIChatRequestBody): InternalRequest {
  let systemPrompt = "";
  const messages: NormalizedMessage[] = [];

  for (const msg of body.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      if (msg.content) systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
      continue;
    }
    if (msg.role === "tool") {
      messages.push({
        role: "tool_result",
        text: msg.content || "",
        toolCallId: msg.tool_call_id,
      });
      continue;
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Assistant message with tool calls
      const textParts: string[] = [];
      if (msg.content) textParts.push(msg.content);
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { _raw: tc.function.arguments };
        }
        textParts.push(`[调用工具 ${tc.function.name}(${JSON.stringify(args)})]`);
      }
      messages.push({ role: "assistant", text: textParts.join("\n") });
      continue;
    }
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      text: msg.content || "",
    });
  }

  const tools: NormalizedTool[] = (body.tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    inputSchema: t.function.parameters as NormalizedTool["inputSchema"],
  }));

  return {
    model: body.model,
    systemPrompt,
    messages,
    tools,
    stream: body.stream ?? false,
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature,
    _protocol: "openai-chat",
    _raw: body,
  };
}

// ─── OpenAI Responses ─────────────────────────────────────────────────

interface OpenAIResponsesTool {
  type: string;
  name: string;
  description?: string;
  parameters?: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

interface OpenAIResponsesInputItem {
  type: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  // For function_call_output
  call_id?: string;
  output?: string;
  // For function_call (in history)
  name?: string;
  arguments?: string;
  id?: string;
}

interface OpenAIResponsesRequestBody {
  model: string;
  input: string | OpenAIResponsesInputItem[];
  instructions?: string;
  tools?: OpenAIResponsesTool[];
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
}

export function normalizeOpenAIResponses(body: OpenAIResponsesRequestBody): InternalRequest {
  let systemPrompt = body.instructions || "";
  const messages: NormalizedMessage[] = [];

  if (typeof body.input === "string") {
    messages.push({ role: "user", text: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type === "message" && item.role) {
        let text = "";
        if (typeof item.content === "string") {
          text = item.content;
        } else if (Array.isArray(item.content)) {
          text = item.content.map((c) => c.text || "").join("");
        }
        if (item.role === "system" || item.role === "developer") {
          systemPrompt += (systemPrompt ? "\n" : "") + text;
        } else {
          messages.push({
            role: item.role === "assistant" ? "assistant" : "user",
            text,
          });
        }
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          text: `[调用工具 ${item.name}(${item.arguments || "{}"})]`,
          toolCallId: item.call_id || item.id,
          toolName: item.name,
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "tool_result",
          text: item.output || "",
          toolCallId: item.call_id,
        });
      }
    }
  }

  const tools: NormalizedTool[] = (body.tools || [])
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: (t.parameters || { type: "object", properties: {} }) as NormalizedTool["inputSchema"],
    }));

  return {
    model: body.model,
    systemPrompt,
    messages,
    tools,
    stream: body.stream ?? false,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    _protocol: "openai-responses",
    _raw: body,
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────

export function normalize(protocol: Protocol, body: unknown): InternalRequest {
  switch (protocol) {
    case "anthropic":
      return normalizeAnthropic(body as AnthropicRequestBody);
    case "openai-chat":
      return normalizeOpenAIChat(body as OpenAIChatRequestBody);
    case "openai-responses":
      return normalizeOpenAIResponses(body as OpenAIResponsesRequestBody);
  }
}
