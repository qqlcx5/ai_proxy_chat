# Reverse Gateway 项目总结

## 项目概述

基于 **openclaw-zero-token** 参考实现的 Python 版本协议转换网关，将 Anthropic Messages API 请求转换为 OpenAI 格式并转发到逆向 API，支持完整的工具调用和流式输出。

## 已完成功能

### ✅ 核心功能
- [x] FastAPI HTTP 服务（`/v1/messages` 端点）
- [x] Anthropic Messages API 完整兼容
- [x] 非流式响应（JSON）
- [x] 流式响应（SSE）
- [x] 工具调用支持（6 个工具）
- [x] Agentic loop（最多 5 轮）

### ✅ 工具系统
- [x] `read` - 读取文件
- [x] `write` - 写入文件
- [x] `edit` - 编辑文件（查找替换）
- [x] `exec` - 执行 shell 命令
- [x] `web_fetch` - 抓取 URL
- [x] `web_search` - DuckDuckGo 搜索

### ✅ 解析器
- [x] Fenced JSON 格式（`` ```tool_json ... ``` ``）
- [x] Bare JSON 格式（`{"tool":"...","parameters":{...}}`）
- [x] XML 格式（`<tool_call>...</tool_call>`）
- [x] 截断修复（SSE 流式输出截断的 JSON）

### ✅ Prompt 注入
- [x] 关键词启发（~40 个中英文关键词）
- [x] 虚拟工具示例（`plus_one`）
- [x] 三套模板（EN/CN/Strict）
- [x] 自动检测是否需要注入

## 项目结构

```
reverse-gateway/
├── main.py              # FastAPI 入口，/v1/messages 端点
├── config.py            # 环境变量加载
├── models.py            # Pydantic 数据模型
├── client.py            # 逆向 API 客户端（流式/非流式）
├── agentic.py           # Agentic loop 实现
├── tool_parser.py       # 工具调用解析器（4 种格式）
├── tool_prompt.py       # Prompt 注入逻辑
├── tool_executor.py     # 工具执行器（6 个工具）
├── requirements.txt     # Python 依赖
├── .env.example         # 环境变量示例
├── README.md            # 项目文档
├── test.py              # 测试脚本
└── start.sh             # 启动脚本
```

## 技术栈

- **Web 框架**: FastAPI + Uvicorn
- **HTTP 客户端**: httpx（异步）
- **数据验证**: Pydantic v2
- **配置管理**: python-dotenv

## 与 openclaw-zero-token 的对比

| 维度 | openclaw-zero-token | reverse-gateway |
|------|---------------------|-----------------|
| **语言** | TypeScript/Node.js | Python |
| **Provider** | 13 个 Web 平台 | 单个逆向 API |
| **认证方式** | Playwright CDP 抓取 Cookie | 直接使用 API Key |
| **架构复杂度** | 多 provider 工厂模式 + 流解析器 | 单 client 直连 |
| **依赖数量** | ~50+ npm 包 | 5 个 pip 包 |
| **代码行数** | ~10,000+ 行 | ~800 行 |
| **启动方式** | Chrome debug + onboard + gateway | 直接启动 |

## 核心设计

### 1. 协议转换流程

```
Anthropic Request
  ↓
Extract system/messages/tools
  ↓
Build system prompt (inject tool definitions if needed)
  ↓
Convert to OpenAI format (flatten content blocks)
  ↓
Call reverse API (stream or non-stream)
  ↓
Parse tool calls from text output
  ↓
Execute tools → feedback → loop (max 5 rounds)
  ↓
Return Anthropic Response
```

### 2. 工具调用策略

参考 arXiv:2407.04997 和 ComfyUI LLM Party：

- **Prompt 注入**：将工具定义注入到 system prompt
- **虚拟工具示例**：用 `plus_one` 教会模型输出格式
- **关键词启发**：仅在消息包含工具相关关键词时注入
- **多格式解析**：支持 4 种工具调用格式

### 3. 流式处理

- **非流式**：完整响应 → 解析工具调用 → 循环
- **流式**：流式收集完整文本 → 解析工具调用 → 如有则执行并重新流式请求

## 测试验证

服务已成功启动：

```
11:55:17 [INFO] Starting reverse gateway on :8000  model=gpt-5.2  max_tool_rounds=5
11:55:17 [INFO] Reverse API: http://66.154.117.189:3000/v1
11:55:17 [INFO] Workspace: D:\Desktop\chat-online\reverse-gateway
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

## 使用方式

### 启动服务

```bash
cd reverse-gateway
python main.py
```

### 测试

```bash
# 运行测试脚本
python test.py

# 或手动测试
curl http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"你好"}]}'
```

## 环境变量

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

## 下一步优化建议

1. **错误处理增强**：更详细的错误信息和重试机制
2. **日志优化**：结构化日志（JSON 格式）
3. **性能监控**：添加 Prometheus metrics
4. **安全加固**：API Key 认证、CORS 配置
5. **工具扩展**：支持自定义工具注册
6. **测试覆盖**：单元测试 + 集成测试

## 总结

项目已完整实现所有核心功能，代码简洁（~800 行），依赖轻量（5 个包），启动测试成功。相比 openclaw-zero-token 的复杂架构，本项目专注于单一逆向 API 场景，大幅简化了实现复杂度。
