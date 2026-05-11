# 🔍 API 代理调试指南

完整的调试方法和故障排查指南。

## 📋 目录

1. [快速调试](#快速调试)
2. [调试模式](#调试模式)
3. [测试脚本](#测试脚本)
4. [日志分析](#日志分析)
5. [常见问题](#常见问题)
6. [手动测试](#手动测试)

---

## 快速调试

### 1. 启动服务（调试模式）

```bash
# 方法 1: 环境变量
DEBUG_MODE=true python api_proxy.py

# 方法 2: 修改 .env 文件
# 在 .env 中添加: DEBUG_MODE=true
python api_proxy.py
```

### 2. 检查服务状态

```bash
# 健康检查
curl http://localhost:8000/health

# 查看配置（不显示完整 API key）
curl http://localhost:8000/debug/config

# 查看统计信息
curl http://localhost:8000/stats
```

### 3. 运行测试套件

```bash
# 确保服务已启动
python test_proxy.py
```

---

## 调试模式

### 开启调试模式

在 `.env` 文件中设置：

```env
DEBUG_MODE=true
```

### 调试模式输出内容

- ✅ 完整的请求/响应日志
- ✅ 请求头信息（API key 会被截断）
- ✅ 请求体 JSON
- ✅ 响应内容预览
- ✅ 流式数据块信息
- ✅ 详细的错误堆栈

### 日志级别

```
INFO  - 基本路由信息
DEBUG - 详细的请求/响应数据（仅在 DEBUG_MODE=true 时）
ERROR - 错误信息
```

---

## 测试脚本

### 运行完整测试

```bash
python test_proxy.py
```

### 测试内容

1. **健康检查** - 验证服务是否运行
2. **配置检查** - 验证 API 配置是否正确
3. **无 tools 请求** - 测试路由到逆向 API
4. **有 tools 请求** - 测试路由到官方 API
5. **流式请求** - 测试流式响应
6. **统计信息** - 查看请求统计

### 预期输出

```
============================================================
  🧪 API 代理测试套件
============================================================

============================================================
  1. 健康检查
============================================================

状态码: 200
响应: {
  "status": "ok",
  "message": "API Proxy is running"
}

...

============================================================
  测试结果汇总
============================================================

✅ 通过  健康检查
✅ 通过  配置检查
✅ 通过  无 tools 请求
✅ 通过  有 tools 请求
✅ 通过  流式请求
✅ 通过  统计信息

总计: 6/6 通过

🎉 所有测试通过！代理服务运行正常。
```

---

## 日志分析

### 正常请求日志

```
2026-05-11 16:00:00 [INFO] [req_1_160000] 收到新请求: /chat
2026-05-11 16:00:00 [INFO] [req_1_160000] ⚡ 无 tools 字段 → 逆向 API
2026-05-11 16:00:00 [INFO] [req_1_160000] 流式模式: False
2026-05-11 16:00:00 [INFO] 发起非流式请求到: https://your-reverse-api.com/v1/chat/completions
2026-05-11 16:00:01 [INFO] 收到响应状态码: 200
```

### 带 tools 的请求日志

```
2026-05-11 16:00:05 [INFO] [req_2_160005] 收到新请求: /chat
2026-05-11 16:00:05 [INFO] [req_2_160005] ✅ 检测到 tools 字段 → 官方 API
2026-05-11 16:00:05 [DEBUG] [req_2_160005] Tools: [{"name": "list_files", ...}]
2026-05-11 16:00:05 [INFO] [req_2_160005] 流式模式: False
2026-05-11 16:00:05 [INFO] 发起非流式请求到: https://api.anthropic.com/v1/messages
2026-05-11 16:00:06 [INFO] 收到响应状态码: 200
```

### 错误日志

```
2026-05-11 16:00:10 [ERROR] [req_3_160010] JSON 解析失败: Expecting value: line 1 column 1 (char 0)
2026-05-11 16:00:15 [ERROR] 转发请求失败: Connection timeout
```

---

## 常见问题

### 1. 服务无法启动

**症状：**
```
Address already in use
```

**解决：**
```bash
# 查找占用 8000 端口的进程
netstat -ano | findstr :8000

# 杀死进程（Windows）
taskkill /PID <进程ID> /F

# 或者修改端口
# 在 api_proxy.py 最后一行改为：
uvicorn.run(app, host="0.0.0.0", port=8001)
```

### 2. API key 未设置

**症状：**
```json
{
  "official_api_key_set": false,
  "reverse_api_key_set": false
}
```

**解决：**
```bash
# 检查 .env 文件是否存在
ls -la .env

# 如果不存在，复制模板
cp .env.example .env

# 编辑 .env 填入真实的 API key
```

### 3. 请求总是路由到同一个 API

**症状：**
所有请求都去官方 API 或都去逆向 API

**排查：**
```bash
# 1. 查看日志确认路由逻辑
# 2. 检查请求体是否正确
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "test"}]}'

# 3. 开启调试模式查看详细信息
DEBUG_MODE=true python api_proxy.py
```

### 4. 逆向 API 返回错误

**症状：**
```
状态码: 401 或 403
```

**排查：**
```bash
# 1. 检查逆向 API 的 URL 和 key
curl http://localhost:8000/debug/config

# 2. 直接测试逆向 API（绕过代理）
curl -X POST https://your-reverse-api.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.2", "messages": [{"role": "user", "content": "test"}]}'

# 3. 检查逆向 API 是否需要特殊的请求头或参数格式
```

### 5. Claude Code 无法连接

**症状：**
Claude Code 报错 "Failed to connect to API"

**排查：**
```bash
# 1. 确认代理服务正在运行
curl http://localhost:8000/health

# 2. 检查 Claude Code 的 API endpoint 配置
# 应该设置为: http://localhost:8000

# 3. 检查防火墙设置
# Windows: 允许 Python 通过防火墙

# 4. 尝试使用 127.0.0.1 而不是 localhost
# 在 Claude Code 中设置: http://127.0.0.1:8000
```

---

## 手动测试

### 测试无 tools 请求

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 100
  }'
```

**预期：** 路由到逆向 API，日志显示 `⚡ 无 tools 字段 → 逆向 API`

### 测试有 tools 请求

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "List files in current directory"}
    ],
    "max_tokens": 100,
    "tools": [
      {
        "name": "list_files",
        "description": "List files in a directory",
        "input_schema": {
          "type": "object",
          "properties": {
            "path": {"type": "string"}
          }
        }
      }
    ]
  }'
```

**预期：** 路由到官方 API，日志显示 `✅ 检测到 tools 字段 → 官方 API`

### 测试流式请求

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "Count from 1 to 5"}
    ],
    "max_tokens": 50,
    "stream": true
  }' \
  --no-buffer
```

**预期：** 看到流式数据逐块返回

### 测试不同路由

```bash
# Anthropic 格式
curl -X POST http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'

# OpenAI 格式
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.2", "messages": [{"role": "user", "content": "test"}]}'

# 通用路由
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'
```

---

## 高级调试

### 使用 Python 交互式测试

```python
import requests
import json

# 测试请求
response = requests.post(
    "http://localhost:8000/chat",
    json={
        "model": "claude-3-5-sonnet-20241022",
        "messages": [{"role": "user", "content": "test"}],
        "max_tokens": 10
    }
)

print(f"状态码: {response.status_code}")
print(f"响应: {response.text}")
```

### 监控实时日志

```bash
# 启动服务并实时查看日志
DEBUG_MODE=true python api_proxy.py 2>&1 | tee proxy.log

# 在另一个终端查看日志
tail -f proxy.log
```

### 性能测试

```bash
# 使用 ab (Apache Bench) 进行压力测试
ab -n 100 -c 10 -p request.json -T application/json http://localhost:8000/chat

# request.json 内容：
# {"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}
```

---

## 调试检查清单

启动前检查：
- [ ] `.env` 文件已创建并配置
- [ ] API keys 已正确填入
- [ ] 端口 8000 未被占用
- [ ] Python 依赖已安装

运行时检查：
- [ ] `/health` 返回 200
- [ ] `/debug/config` 显示 API keys 已设置
- [ ] 日志显示正确的路由逻辑
- [ ] 测试脚本全部通过

问题排查：
- [ ] 查看详细日志（DEBUG_MODE=true）
- [ ] 检查 API endpoint 配置
- [ ] 直接测试上游 API
- [ ] 检查网络连接和防火墙

---

## 获取帮助

如果以上方法都无法解决问题：

1. 收集以下信息：
   - 完整的错误日志
   - `/debug/config` 的输出
   - `/stats` 的输出
   - 你的请求示例

2. 检查上游 API 的文档，确认请求格式是否正确

3. 尝试直接调用上游 API（绕过代理）来隔离问题
