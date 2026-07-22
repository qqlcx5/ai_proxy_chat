export type Protocol = "anthropic" | "openai-chat" | "openai-responses";

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
}

export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type NormalizedRole = "user" | "assistant" | "tool_result";

export interface NormalizedMessage {
  role: NormalizedRole;
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
  protocol: Protocol;
}

export interface ParsedToolCall {
  tool: string;
  parameters: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "error" | "length";

export interface InternalResponse {
  text: string;
  toolCalls: ParsedToolCall[];
  stopReason: StopReason;
  error?: string;
}
