# Gateway 增强版

Protocol-conversion gateway: Anthropic ↔ OpenAI-compatible (via PydanticAI)

## 核心功能

### 1. Agentic Loop（智能循环）
- 自动处理工具调用：模型 → 工具执行 → 反馈 → 继续
- 最多 5 轮循环（可配置）
- 无需客户端实现 tool calling 逻辑

### 2. 健壮的解析器（移植自 openclaw-zero-token）
支持 5 种工具调用格式：
- **Fenced code block**: `` ```tool_json\n{"tool":"read","parameters":{"path":"file.txt"}}\n``` ``
- **Bare JSON**: `{"tool":"read","parameters":{"path":"file.txt"}}`
- **XML**: `<tool_call>{"name":"read","arguments":{"path":"file.txt"}}</tool_call>`
- **Legacy XML**: `<tool_call_request><name>read</name><arguments>{"path":"file.txt"}</arguments></tool_call_request>`
- **Fuzzy repair**: 自动修复截断的 JSON（SSE 流常见问题）

### 3. 完整工具集
- `read` - 读取文件（支持绝对/相对路径）
- `write` - 写入文件（自动创建目录）
- `edit` - 查找替换编辑
- `exec` - 执行 shell 命令（30s 超时）
- `web_fetch` - 抓取 URL 内容
- `web_search` - DuckDuckGo 搜索（无需 API key）

### 4. 示例驱动的 Prompt 注入
- 基于 arXiv:2407.04997 论文和 ComfyUI LLM Party 实现
- 使用简单示例教模型输出格式
- 关键词启发式：只在需要时注入工具 prompt（减少封号风险）

## 环境变量

```bash
# 必需
REVERSE_API_URL=https://your-reverse-api.com/v1/chat/completions
REVERSE_API_KEY=your-api-key

# 可选
REVERSE_API_MODEL=gpt-5.2          # 默认模型
GATEWAY_PORT=8000                   # 网关端口
DEBUG_MODE=false                    # 调试模式
MAX_TOOL_ROUNDS=5                   # 最大工具调用轮数
EXEC_TIMEOUT=30                     # 命令执行超时（秒）
WORKSPACE=.                         # 工具操作的工作目录
```

## 使用方式

### 启动网关
```bash
# 使用虚拟环境
.venv/Scripts/python.exe gateway.py

# 或直接运行
python gateway.py
```

### 测试工具
```bash
python test_gateway_tools.py
```

### 客户端配置
将 Claude 客户端的 API endpoint 指向网关：
```bash
# 例如在 .env 中
ANTHROPIC_API_URL=http://localhost:8000
ANTHROPIC_API_KEY=your-reverse-api-key
```

## 工作流程

```
用户请求
  ↓
网关接收 Anthropic 格式请求
  ↓
转换为 PydanticAI 格式
  ↓
注入工具定义到 system prompt
  ↓
[Agentic Loop 开始]
  ↓
调用逆向 API（纯文本对话模式）
  ↓
解析响应（5 种格式 + fuzzy repair）
  ↓
发现工具调用？
  ├─ 是 → 执行工具 → 反馈结果 → 继续循环
  └─ 否 → 返回最终答案
  ↓
转换为 Anthropic 格式响应
  ↓
返回给客户端
```

## 日志示例

```
12:34:56 [INFO] Starting gateway on :8000  model=gpt-5.2  max_tool_rounds=5
12:34:56 [INFO] Workspace: D:\Desktop\chat-online
12:34:56 [INFO] Tool execution timeout: 30s
12:35:10 [INFO] >>> request  model=gpt-5.2  tools=6  messages=2
12:35:10 [DEBUG]   tool names: ['read', 'write', 'edit', 'exec', 'web_fetch', 'web_search']
12:35:10 [DEBUG]   agentic loop round 1/5
12:35:12 [INFO]     tool_call: read({"path":"gateway.py"})
12:35:12 [INFO]   Executing tool: read with args: {'path': 'gateway.py'}
12:35:12 [DEBUG]     Reading file: gateway.py
12:35:12 [DEBUG]   agentic loop round 2/5
12:35:15 [INFO] <<< response text (245 chars): The gateway.py file is a protocol conversion...
```

## 技术细节

### 关键词启发式
只在用户消息包含以下关键词时注入工具 prompt：
- 英文：file, read, write, edit, exec, run, command, shell, search, fetch, url, http, download, install, update
- 中文：文件, 读取, 写入, 编辑, 执行, 运行, 命令, 终端, 搜索, 查找, 查询, 抓取, 网页, 下载, 安装, 更新, 帮我, 查看, 看看, 检查

### 路径处理
- 支持绝对路径：`D:\Desktop\file.txt`
- 支持相对路径：`src/main.py`（相对于 WORKSPACE）
- 自动创建父目录（write 工具）

### 安全限制
- 命令执行超时：30 秒（可配置）
- 文件读取截断：50,000 字符
- Web 抓取截断：50,000 字符
- 搜索结果：最多 5 条

## 参考资料

- [arXiv:2407.04997](https://arxiv.org/html/2407.04997v1) - Prompt-based tool calling 论文
- [ComfyUI LLM Party](https://github.com/heshengtao/comfyui_LLM_party) - 示例驱动的实现
- [openclaw-zero-token](https://github.com/openclaw/openclaw-zero-token) - TypeScript 原始实现
