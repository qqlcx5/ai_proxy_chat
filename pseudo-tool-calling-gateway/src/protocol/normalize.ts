import type {
  InternalRequest,
  JsonSchema,
  NormalizedMessage,
  NormalizedTool,
  Protocol,
} from "./types.js";

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block == null) continue;
    if (typeof block === "string") { parts.push(block); continue; }
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

function coerceSchema(raw: unknown): JsonSchema {
  if (raw && typeof raw === "object") return raw as JsonSchema;
  return { type: "object", properties: {} };
}

// --- Anthropic ---
interface AnthropicTool { name?: string; description?: string; input_schema?: unknown; inputSchema?: unknown }
interface AnthropicMessage { role?: string; content?: unknown }

function extractAnthropicSystem(system: unknown): string {
  if (typeof system === "string") return system;
  return contentToText(system);
}

function anthropicMessageToNormalized(m: AnthropicMessage): NormalizedMessage[] {
  const role = m.role ?? "user";
  if (Array.isArray(m.content)) {
    const out: NormalizedMessage[] = [];
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (role === "user" && block?.type === "tool_result") {
        // Anthropic tool_result arrives inside a user message
        out.push({
          role: "tool_result",
          text: contentToText(block.content),
          toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        });
      } else if (role === "assistant" && block?.type === "tool_use") {
        // Preserve history: the model's previous tool call, flattened to readable text
        const name = typeof block.name === "string" ? block.name : "?";
        let args = "";
        try { args = JSON.stringify(block.input ?? {}); } catch { /* skip */ }
        out.push({ role: "assistant", text: `[called tool ${name}(${args})]` });
      } else if (block?.type === "text" && typeof block.text === "string") {
        out.push({ role: role === "assistant" ? "assistant" : "user", text: block.text });
      }
    }
    if (out.length > 0) return out;
  }
  return [{ role: role === "assistant" ? "assistant" : "user", text: contentToText(m.content) }];
}

export function normalizeAnthropic(body: unknown): InternalRequest {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new Error("anthropic: body must be an object");
  const tools: NormalizedTool[] = [];
  if (Array.isArray(b.tools)) {
    for (const t of b.tools as AnthropicTool[]) {
      if (!t || typeof t.name !== "string") continue;
      tools.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: coerceSchema(t.input_schema ?? t.inputSchema),
      });
    }
  }
  const messages: NormalizedMessage[] = [];
  if (Array.isArray(b.messages)) {
    for (const m of b.messages as AnthropicMessage[]) messages.push(...anthropicMessageToNormalized(m));
  }
  return {
    model: typeof b.model === "string" ? b.model : "",
    systemPrompt: extractAnthropicSystem(b.system),
    messages, tools,
    stream: b.stream === true,
    maxTokens: typeof b.max_tokens === "number" ? b.max_tokens : undefined,
    temperature: typeof b.temperature === "number" ? b.temperature : undefined,
    protocol: "anthropic",
  };
}

// --- OpenAI Chat ---
interface OpenAiChatTool { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }
interface OpenAiChatMessage { role?: string; content?: unknown; tool_call_id?: string; name?: string; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> }

export function normalizeOpenAiChat(body: unknown): InternalRequest {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new Error("openai-chat: body must be an object");
  const tools: NormalizedTool[] = [];
  if (Array.isArray(b.tools)) {
    for (const t of b.tools as OpenAiChatTool[]) {
      const fn = t?.function;
      if (!fn || typeof fn.name !== "string") continue;
      tools.push({
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        inputSchema: coerceSchema(fn.parameters),
      });
    }
  }
  const messages: NormalizedMessage[] = [];
  let systemPrompt = "";
  if (Array.isArray(b.messages)) {
    for (const m of b.messages as OpenAiChatMessage[]) {
      const role = m.role ?? "user";
      if (role === "system" || role === "developer") {
        systemPrompt += (systemPrompt ? "\n" : "") + contentToText(m.content);
      } else if (role === "tool") {
        messages.push({
          role: "tool_result",
          text: contentToText(m.content),
          toolCallId: m.tool_call_id,
          toolName: m.name,
        });
      } else {
        // assistant tool_calls history → flattened; plain text otherwise
        let text = contentToText(m.content);
        if (role === "assistant" && Array.isArray(m.tool_calls)) {
          const calls = m.tool_calls
            .map((tc) => `[called tool ${tc?.function?.name ?? "?"}(${tc?.function?.arguments ?? ""})]`)
            .join(" ");
          text = text ? `${text}\n${calls}` : calls;
        }
        messages.push({ role: role === "assistant" ? "assistant" : "user", text });
      }
    }
  }
  return {
    model: typeof b.model === "string" ? b.model : "",
    systemPrompt, messages, tools,
    stream: b.stream === true,
    maxTokens: typeof b.max_tokens === "number" ? b.max_tokens : undefined,
    temperature: typeof b.temperature === "number" ? b.temperature : undefined,
    protocol: "openai-chat",
  };
}

// --- OpenAI Responses ---
interface ResponsesTool { type?: string; name?: string; description?: string; parameters?: unknown }
interface ResponsesInputItem { type?: string; role?: string; content?: unknown; call_id?: string; output?: unknown }

export function normalizeOpenAiResponses(body: unknown): InternalRequest {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new Error("openai-responses: body must be an object");
  const tools: NormalizedTool[] = [];
  if (Array.isArray(b.tools)) {
    for (const t of b.tools as ResponsesTool[]) {
      if (typeof t?.name !== "string") continue;
      tools.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: coerceSchema(t.parameters),
      });
    }
  }
  const messages: NormalizedMessage[] = [];
  const input = b.input;
  if (typeof input === "string") messages.push({ role: "user", text: input });
  else if (Array.isArray(input)) {
    for (const item of input as ResponsesInputItem[]) {
      if (!item || typeof item !== "object") continue;
      const type = item.type;
      if (type === "function_call_output") {
        messages.push({
          role: "tool_result",
          text: typeof item.output === "string" ? item.output : contentToText(item.output),
          toolCallId: item.call_id,
        });
      } else if (type === "message" || item.role) {
        messages.push({
          role: item.role === "assistant" ? "assistant" : "user",
          text: contentToText(item.content),
        });
      }
    }
  }
  return {
    model: typeof b.model === "string" ? b.model : "",
    systemPrompt: typeof b.instructions === "string" ? b.instructions : "",
    messages, tools,
    stream: b.stream === true,
    maxTokens: typeof b.max_output_tokens === "number" ? b.max_output_tokens : undefined,
    temperature: typeof b.temperature === "number" ? b.temperature : undefined,
    protocol: "openai-responses",
  };
}

export function normalize(protocol: Protocol, body: unknown): InternalRequest {
  switch (protocol) {
    case "anthropic": return normalizeAnthropic(body);
    case "openai-chat": return normalizeOpenAiChat(body);
    case "openai-responses": return normalizeOpenAiResponses(body);
  }
}
