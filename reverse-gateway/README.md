# Reverse Gateway

Anthropic Messages API 兼容的协议转换网关，将请求转发到逆向 API（OpenAI 格式），支持完整的工具调用和流式输出。

## 特性

- ✅ **Anthropic Messages API 兼容** — 完整支持 `/v1/messages` 端点
- ✅ **流式输出** — SSE 流式响应，实时返回模型输出
- ✅ **工具调用** — 通过 prompt 注入实现 6 个工具（read/write/edit/exec/web_search/web_fetch）
- ✅ **Agentic Loop** — 自动执行工具并反馈结果，最多 5 轮循环
- ✅ **多格式解析** — 支持 fenced JSON、bare JSON、XML、截断修复
- ✅ **关键词启发** — 仅在需要时注入工具提示，降低封禁风险

## 架构

参考 [openclaw-zero-token](https://github.com/openclaw/openclaw) 的工具调用设计：

```
Client (Anthropic API)
    ↓
Gateway (协议转换 + 工具注入)
    ↓
Reverse API (OpenAI 格式)
    ↓
Agentic Loop (解析工具调用 → 执行 → 反馈)
```

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写：

```bash
REVERSE_API_URL=http://your-reverse-api-host:3000/v1/chat/completions
REVERSE_API_KEY=your-api-key
REVERSE_API_MODEL=gpt-5.2
GATEWAY_PORT=8000
DEBUG_MODE=false
MAX_TOOL_ROUNDS=5
EXEC_TIMEOUT=30
WORKSPACE=./
```

### 3. 启动服务

```bash
python main.py
```

服务将在 `http://localhost:8000` 启动。

## 使用示例

### 非流式请求

```bash
curl http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### 流式请求

```bash
curl -N http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 工具调用

```bash
curl http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role": "user", "content": "帮我读取 config.py 的内容"}],
    "tools": [{
      "name": "read",
      "description": "Read file",
      "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"]
      }
    }]
  }'
```

## 工具列表

| 工具 | 描述 | 参数 |
|------|------|------|
| `read` | 读取文件 | `path: string` |
| `write` | 写入文件 | `path: string, content: string` |
| `edit` | 编辑文件（查找替换） | `path: string, old: string, new: string` |
| `exec` | 执行 shell 命令 | `command: string` |
| `web_fetch` | 抓取 URL 内容 | `url: string` |
| `web_search` | 搜索网页（DuckDuckGo） | `query: string` |

## 项目结构

```
reverse-gateway/
├── main.py              # FastAPI 入口
├── config.py            # 配置加载
├── models.py            # Pydantic 数据模型
├── client.py            # 逆向 API 客户端
├── agentic.py           # Agentic loop 实现
├── tool_parser.py       # 工具调用解析器
├── tool_prompt.py       # Prompt 注入逻辑
├── tool_executor.py     # 工具执行器
├── requirements.txt     # Python 依赖
└── .env.example         # 环境变量示例
```

## 与 openclaw-zero-token 的区别

| 特性 | openclaw-zero-token | reverse-gateway |
|------|---------------------|-----------------|
| 语言 | TypeScript/Node.js | Python |
| Provider | 13 个 Web 平台 | 单个逆向 API |
| 认证 | Playwright CDP 抓取 | 直接使用 API Key |
| 架构 | 多 provider 工厂模式 | 单 client 直连 |
| 依赖 | PydanticAI + 大量依赖 | FastAPI + httpx（轻量） |

## License

MIT
