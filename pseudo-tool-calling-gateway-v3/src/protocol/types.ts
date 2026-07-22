/**
 * Internal Representation (IR) types — the unified protocol-agnostic format.
 * All three upstream protocols (Anthropic, OpenAI Chat, OpenAI Responses)
 * normalize into this, the engine works with it, and responses denormalize back.
 */

export type Protocol = "anthropic" | "openai-chat" | "openai-responses";

export interface JSONSchema {
  type: string;
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface NormalizedMessage {
  role: "user" | "assistant" | "tool_result";
  text: string;
  toolCallId?: string;
  toolName?: string;
}

export interface InternalRequest {
  model: string;
  systemPrompt: string;
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  _protocol: Protocol;
  _raw: unknown;
}

export interface ParsedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

export interface InternalResponse {
  text: string;
  toolCalls: ParsedToolCall[];
  stopReason: "end_turn" | "tool_use" | "stop";
  usage?: {
    input?: number;
    output?: number;
  };
}
