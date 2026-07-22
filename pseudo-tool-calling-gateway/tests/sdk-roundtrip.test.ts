/**
 * SDK round-trip contract tests — PRD §8.2.
 *
 * The most bug-prone part of this gateway: the responses we fabricate must be
 * parseable by the OFFICIAL SDKs that pi / Claude Code / Codex use. If a field
 * name, nesting level, or the arguments-string-not-object invariant is wrong,
 * the SDK throws and the client breaks.
 *
 * These tests spin up the gateway with a mock upstream and drive it through
 * the real SDKs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Mock upstream: returns a model response that emits a tool_json block.
// ---------------------------------------------------------------------------
function startMockUpstream(port: number): Promise<void> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
      const chunks = [
        // model "decides" to call read(path=foo.txt)
        'data: {"choices":[{"delta":{"content":"```tool_json\\n{\\"tool\\":\\"read\\",\\"parameters\\":{\\"path\\":\\"foo.txt\\"}}\\n```\\n"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      chunks.forEach((c) => res.write(c));
      res.end();
    });
    srv.listen(port, () => resolve());
  });
}

let gwProc: ChildProcess | null = null;
const GW_PORT = 8799;
const UP_PORT = 8798;

beforeAll(async () => {
  await startMockUpstream(UP_PORT);
  gwProc = spawn("npx", ["tsx", "src/index.ts"], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(GW_PORT),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${UP_PORT}/v1`,
      UPSTREAM_API_KEY: "test",
      GATEWAY_LOG_LEVEL: "warn", // quiet during tests
    },
    stdio: "ignore",
  });
  // wait for gateway to be ready
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const ok = await fetch(`http://127.0.0.1:${GW_PORT}/__health`);
      if (ok.ok) break;
    } catch { /* retry */ }
  }
}, 30000);

afterAll(() => {
  gwProc?.kill();
});

// ---------------------------------------------------------------------------
// Anthropic SDK contract
// ---------------------------------------------------------------------------
describe("Anthropic SDK round-trip", () => {
  it("parses a text response from gateway", async () => {
    // Override mock to return plain text for this case
    // (the default mock returns tool_json; we point at a dedicated behavior by
    //  using a model id the mock doesn't special-case — it always returns tool_json,
    //  so here we just assert the SDK can talk to the gateway at all.)
    const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${GW_PORT}` });
    // We expect tool_use because the mock always emits tool_json.
    const msg = await client.messages.create({
      model: "x",
      max_tokens: 50,
      messages: [{ role: "user", content: "read foo" }],
      tools: [{ name: "read", description: "r", input_schema: { type: "object", properties: {} } }],
    });
    expect(msg.role).toBe("assistant");
    expect(msg.stop_reason).toBe("tool_use");
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.type).toBe("tool_use");
    if (toolUse!.type === "tool_use") {
      expect(toolUse!.name).toBe("read");
      expect(toolUse!.input).toEqual({ path: "foo.txt" });
    }
  });

  it("parses a streamed response with tool_use via SDK", async () => {
    const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${GW_PORT}` });
    const stream = await client.messages.stream({
      model: "x",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "read foo" }],
      tools: [{ name: "read", description: "r", input_schema: { type: "object", properties: {} } }],
    });
    const final = await stream.finalMessage();
    expect(final.stop_reason).toBe("tool_use");
    const toolUse = final.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    if (toolUse!.type === "tool_use") {
      expect(toolUse!.input).toEqual({ path: "foo.txt" });
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAI SDK contract (Chat Completions)
// ---------------------------------------------------------------------------
describe("OpenAI Chat Completions SDK round-trip", () => {
  it("parses tool_calls from gateway (arguments must be string)", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL: `http://127.0.0.1:${GW_PORT}/v1` });
    const completion = await client.chat.completions.create({
      model: "x",
      messages: [{ role: "user", content: "read foo" }],
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: {} } } }],
    });
    const choice = completion.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    const tc = choice.message.tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc!.function.name).toBe("read");
    // SDK returns arguments as string; we parse it
    expect(JSON.parse(tc!.function.arguments)).toEqual({ path: "foo.txt" });
  });

  it("parses a streamed tool_calls response", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL: `http://127.0.0.1:${GW_PORT}/v1` });
    const stream = await client.chat.completions.create({
      model: "x",
      stream: true,
      messages: [{ role: "user", content: "read foo" }],
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: {} } } }],
    });
    const chunks: any[] = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    // final chunk should have finish_reason
    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);
    expect(finishChunk.choices[0].finish_reason).toBe("tool_calls");
  });
});

// ---------------------------------------------------------------------------
// OpenAI SDK contract (Responses API)
// ---------------------------------------------------------------------------
describe("OpenAI Responses SDK round-trip", () => {
  it("parses function_call from gateway", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL: `http://127.0.0.1:${GW_PORT}/v1` });
    const resp = await client.responses.create({
      model: "x",
      input: "read foo",
      tools: [{ type: "function", name: "read", description: "r", parameters: { type: "object", properties: {} } }],
    }) as any;
    expect(resp.status).toBe("completed");
    const fc = resp.output.find((o: any) => o.type === "function_call");
    expect(fc).toBeDefined();
    expect(fc.name).toBe("read");
    expect(JSON.parse(fc.arguments)).toEqual({ path: "foo.txt" });
  });
});
