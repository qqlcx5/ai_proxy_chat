# pseudo-tool-calling-gateway

A gateway that adds **tool calling capability** to LLMs that don't natively support it, using prompt injection + response parsing.

Works with any OpenAI-compatible API and exposes three protocol endpoints so clients like **pi**, **Claude Code**, and **Codex** can connect without modification.

## How It Works

```
Client (Anthropic/OpenAI protocol)
    │
    ▼
┌─────────────────────────────────┐
│  Gateway                        │
│  1. Normalize → IR              │
│  2. Strip tools from request    │
│  3. Inject tool prompt          │
│  4. Forward to upstream LLM     │
│  5. Parse response for calls    │
│  6. Denormalize → client format │
└─────────────────────────────────┘
    │
    ▼
Upstream LLM (no native tool calling)
```

## Quick Start

```bash
# Install dependencies
npm install

# Set upstream API
export UPSTREAM_BASE_URL="http://your-api/v1"
export UPSTREAM_API_KEY="your-key"

# Start the gateway
npm start

# Or with custom port
npm start -- --port 9090 --host 0.0.0.0
```

## Endpoints

| Method | Path | Protocol |
|--------|------|----------|
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/messages` | Anthropic Messages |
| GET | `/__health` | Health check |
| GET | `/__models` | Registered models |
| POST | `/__debug/parse` | Debug parser |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UPSTREAM_BASE_URL` | `http://66.154.117.189:3000/v1` | Upstream API base URL |
| `UPSTREAM_API_KEY` | (empty) | API key for upstream |
| `GATEWAY_HOST` | `127.0.0.1` | Listen host |
| `GATEWAY_PORT` | `8787` | Listen port |

### Model Registration

Models are registered in `src/config/models.ts`:

```typescript
{
  id: "gpt-5.6-luna",        // What clients send
  upstreamModel: "gpt-5.6-luna", // What upstream sees
  profile: "gpt",            // Injection profile
}
```

### Profiles

Profiles in `profiles/gpt.toml` control:
- `inject_mode`: `always` | `never` | `auto`
- `teaching_examples`: Include example tool call in prompt
- `repair`: Auto-repair truncated/malformed JSON in responses

## Supported Tool Call Formats

The parser handles all of these:

1. **Fenced JSON** (GLM style):
   ````tool_json
   {"tool":"read","parameters":{"path":"README.md"}}
   ````

2. **Bare JSON**:
   ```json
   {"tool":"read","parameters":{"path":"README.md"}}
   ```

3. **XML wrapped** (DeepSeek style):
   ```xml
   <tool_call>{"tool":"read","parameters":{"path":"README.md"}}</tool_call>
   ```

4. **OpenAI style**:
   ```json
   {"name":"read","arguments":{"path":"README.md"}}
   ```

Plus auto-repair for:
- Truncated JSON (missing closing braces from streaming)
- String-encoded arguments (`"arguments":"{\"path\":\"...\"}"`)
- Mixed format outputs

## Architecture

```
src/
├── cli.ts                      # CLI entry point
├── config/
│   ├── gateway.ts              # Gateway config + loader
│   └── models.ts               # Model registry
├── engine/
│   ├── loop.ts                 # Request orchestration
│   ├── parser.ts               # Tool call extraction + repair
│   ├── prompt-injector.ts      # Tool prompt injection
│   └── upstream-client.ts      # Upstream API client
├── protocol/
│   ├── types.ts                # Internal IR types
│   ├── normalize.ts            # 3 protocols → IR
│   └── denormalize.ts          # IR → 3 protocols
└── server/
    └── router.ts               # HTTP routes
```

## Development

```bash
# Run tests
npm test

# Run in dev mode (hot reload)
npm run dev

# Type check
npx tsc --noEmit
```

## Design Decisions

- **No internal loop**: The gateway processes one request → one response. Multi-turn orchestration is the client's job.
- **Strategy A (cache full response)**: For v1, we cache the complete upstream response before parsing. Streaming support exists but is best-effort.
- **Default `inject_mode=always`**: Tool prompt is always injected when tools are present.
- **Compact tool definitions**: JSON Schema is stripped to name + description + param names. No `type`, `required`, etc.

## License

MIT
