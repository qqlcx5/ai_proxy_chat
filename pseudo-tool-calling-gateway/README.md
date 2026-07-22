# pseudo-tool-calling-gateway

A local HTTP gateway that fakes native tool calling for reverse-proxy
LLM APIs. Lets **pi**, **Claude Code**, and **Codex** use any text-only
OpenAI-compatible endpoint that ignores `tools` and never returns
`tool_calls`.

> See [`PRD-pseudo-tool-calling-gateway.md`](../PRD-pseudo-tool-calling-gateway.md)
> for the full design spec.

## What it does

```
┌──────────────────────────────────────┐
│  pi  /  Claude Code  /  Codex        │
│  (each speaks only its native API)   │
└──────────────┬───────────────────────┘
               │ OpenAI Chat / Responses
               │ or Anthropic Messages  (with tools)
               ▼
      ┌──────────────────────┐
      │  this gateway        │  localhost:8787
      │                      │
      │  ① 3 protocol routes │
      │  ② tools → prompt    │
      │  ③ parse text → tool │
      │  ④ fake tool_call    │
      └──────────┬───────────┘
                 │ plain prompt
                 │ plain text stream
                 ▼
        Your reverse-proxy LLM
```

## Quick start

```bash
# 1. install
pnpm install

# 2. set the upstream API key
cp .env.example .env
$EDITOR .env

# 3. (optional) adjust config/gateway.json — upstream base_url, port, etc.

# 4. run
pnpm dev
# → listening on http://127.0.0.1:8787

# 5. try it
curl -s http://127.0.0.1:8787/__health
curl -s http://127.0.0.1:8787/__models
```

## Wire a coding agent

### pi

Add a provider to `~/.pi/agent/models.json`:

```jsonc
{
  "providers": {
    "mocktool-anthropic": {
      "api": "anthropic-messages",
      "baseUrl": "http://127.0.0.1:8787",
      "apiKey": "any",
      "models": [{ "id": "gpt-5.6-luna", "name": "GPT-5.6 Luna (mocktool)" }]
    },
    "mocktool-openai-responses": {
      "api": "openai-responses",
      "baseUrl": "http://127.0.0.1:8787/v1",
      "apiKey": "any",
      "models": [{ "id": "gpt-5.6-luna", "name": "GPT-5.6 Luna (mocktool)" }]
    }
  }
}
```

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=any
claude --model gpt-5.6-luna
```

### Codex

Point at `http://127.0.0.1:8787/v1`, model id = `gpt-5.6-luna`.

## Endpoints

| Method | Path                 | Purpose                                 |
|--------|----------------------|-----------------------------------------|
| POST   | `/v1/chat/completions` | OpenAI Chat Completions (pi, Codex)   |
| POST   | `/v1/responses`        | OpenAI Responses (pi, Codex)          |
| POST   | `/v1/messages`         | Anthropic Messages (pi, Claude Code)  |
| GET    | `/__health`            | Liveness + upstream probe             |
| GET    | `/__models`            | Registered models + profiles          |
| POST   | `/__debug/parse`       | Parse a text blob → tool_call        |

## Configuration

- `config/gateway.json` — server + upstream
- `config/models.json`  — model registry
- `profiles/*.json`     — per-family prompt strategy

`api_key` supports `${ENV_VAR}` expansion.

## Tests

```bash
pnpm test                  # all
pnpm test:watch            # watch mode
pnpm test tests/unit       # just unit
```

The e2e tests boot a full mock upstream + the gateway in-process — no
real reverse-proxy required.

## Project layout

```
src/
├── server/         HTTP handlers (3 protocols + debug)
├── protocol/       IR types + normalise / denormalise
├── engine/         prompt-injector, parser, flatten, orchestrator
└── config/         JSON loader
profiles/           per-family prompt strategies
config/             runtime config
tests/              unit / contract / e2e / golden
```

## Credits

- Parser & prompt design ported and hardened from
  `openclaw-zero-token/src/zero-token/tool-calling/`.
- Pseudo-tool-calling approach from
  [arXiv:2407.04997](https://arxiv.org/html/2407.04997v1) and
  [ComfyUI LLM Party](https://github.com/heshengtao/comfyui_LLM_party).
