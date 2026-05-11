# AI API 智能路由代理

根据请求是否包含 `tools` 字段，自动路由到官方或逆向 API。

## 功能

- ✅ 自动检测请求中的 `tools` 字段
- ✅ 有 tools → 转发到官方 API（支持 tool calling）
- ✅ 无 tools → 转发到逆向 API（节省成本）
- ✅ 支持 OpenAI 和 Anthropic 格式
- ✅ 支持流式和非流式响应

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 API

复制配置文件并填入你的 API 信息：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 官方 API（支持 tools）
OFFICIAL_API_URL=https://api.anthropic.com/v1/messages
OFFICIAL_API_KEY=sk-ant-xxxxx

# 逆向 API（不支持 tools）
REVERSE_API_URL=https://your-reverse-api.com/v1/chat/completions
REVERSE_API_KEY=your_key_here
```

### 3. 启动服务

```bash
python api_proxy.py
```

服务将在 `http://localhost:8000` 启动。

### 4. 配置 Claude Code

在 Claude Code 中配置 API endpoint：

```bash
# 方法 1: 使用命令行参数
claude --api-url http://localhost:8000

# 方法 2: 设置环境变量
export ANTHROPIC_API_URL=http://localhost:8000
```

或在 Claude Code 设置中修改 API endpoint 为 `http://localhost:8000`。

## 工作原理

```
用户请求 → localhost:8000/chat
         ↓
    检测 tools 字段？
         ↓
    ├── 有 tools → 官方 API（支持 tool calling）
    └── 无 tools → 逆向 API（纯对话）
```

## 支持的路由

- `POST /v1/messages` - Anthropic 格式
- `POST /v1/chat/completions` - OpenAI 格式
- `POST /chat` - 通用入口
- `GET /health` - 健康检查

## 测试

```bash
# 测试健康检查
curl http://localhost:8000/health

# 测试无 tools 请求（会路由到逆向 API）
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 测试有 tools 请求（会路由到官方 API）
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Read file.txt"}],
    "tools": [{"name": "read_file", "description": "Read a file"}]
  }'
```

## 注意事项

1. **API 格式兼容性**：确保你的逆向 API 支持 OpenAI 或 Anthropic 格式
2. **流式响应**：代理自动检测 `stream: true` 并正确转发
3. **超时设置**：默认 300 秒，可在代码中调整
4. **日志输出**：每次请求会打印路由信息，方便调试

## 故障排查

**问题：Claude Code 无法连接**
- 检查代理服务是否启动：`curl http://localhost:8000/health`
- 检查防火墙设置

**问题：请求总是路由到同一个 API**
- 检查 `.env` 配置是否正确
- 查看控制台日志确认路由逻辑

**问题：逆向 API 返回错误**
- 确认逆向 API 的 URL 和格式
- 某些逆向 API 可能需要特殊的请求头或参数格式
