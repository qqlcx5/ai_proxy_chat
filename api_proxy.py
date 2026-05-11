"""
AI API 智能路由代理
根据请求是否包含 tools 字段，自动路由到官方或逆向 API
"""
import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import json
import os
import logging
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# 配置日志
DEBUG_MODE = os.getenv("DEBUG_MODE", "false").lower() == "true"
logging.basicConfig(
    level=logging.DEBUG if DEBUG_MODE else logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

app = FastAPI()

# 配置 API endpoints
OFFICIAL_API_URL = os.getenv("OFFICIAL_API_URL", "https://api.anthropic.com/v1/messages")
REVERSE_API_URL = os.getenv("REVERSE_API_URL", "https://your-reverse-api.com/v1/chat/completions")
OFFICIAL_API_KEY = os.getenv("OFFICIAL_API_KEY", "")
REVERSE_API_KEY = os.getenv("REVERSE_API_KEY", "")
REVERSE_API_MODEL = os.getenv("REVERSE_API_MODEL", "gpt-5.2")

# 统计信息
stats = {
    "total_requests": 0,
    "official_api_requests": 0,
    "reverse_api_requests": 0,
    "errors": 0
}


async def forward_request(target_url: str, api_key: str, request_data: dict, headers: dict, is_stream: bool):
    """转发请求到目标 API"""
    forward_headers = {
        "Content-Type": "application/json",
    }

    # 根据 API 类型设置认证头
    if "anthropic.com" in target_url:
        forward_headers["x-api-key"] = api_key
        forward_headers["anthropic-version"] = "2023-06-01"
    else:
        forward_headers["Authorization"] = f"Bearer {api_key}"

    if DEBUG_MODE:
        logger.debug(f"转发到: {target_url}")
        logger.debug(f"请求头: {json.dumps({k: v[:20] + '...' if len(v) > 20 else v for k, v in forward_headers.items()}, ensure_ascii=False)}")
        logger.debug(f"请求体: {json.dumps(request_data, ensure_ascii=False, indent=2)}")

    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            if is_stream:
                logger.info(f"发起流式请求到: {target_url}")
                async with client.stream("POST", target_url, json=request_data, headers=forward_headers) as response:
                    logger.info(f"收到响应状态码: {response.status_code}")
                    async def generate():
                        async for chunk in response.aiter_bytes():
                            if DEBUG_MODE:
                                logger.debug(f"流式数据块: {chunk[:100]}...")
                            yield chunk
                    return StreamingResponse(generate(), media_type="text/event-stream")
            else:
                logger.info(f"发起非流式请求到: {target_url}")
                response = await client.post(target_url, json=request_data, headers=forward_headers)
                logger.info(f"收到响应状态码: {response.status_code}")

                if DEBUG_MODE:
                    logger.debug(f"响应内容: {response.text[:500]}...")

                return Response(content=response.content, status_code=response.status_code, media_type="application/json")
    except Exception as e:
        logger.error(f"转发请求失败: {str(e)}")
        stats["errors"] += 1
        raise


@app.post("/v1/messages")
@app.post("/v1/chat/completions")
@app.post("/chat")
async def proxy_chat(request: Request):
    """统一代理入口"""
    stats["total_requests"] += 1
    request_id = f"req_{stats['total_requests']}_{datetime.now().strftime('%H%M%S')}"

    logger.info(f"[{request_id}] 收到新请求: {request.url.path}")

    try:
        body = await request.body()
        request_data = json.loads(body)

        # 记录原始模型
        original_model = request_data.get("model", "unknown")

        # 检测是否包含 tools 字段
        has_tools = "tools" in request_data and request_data["tools"]

        # 选择目标 API
        if has_tools:
            target_url = OFFICIAL_API_URL
            api_key = OFFICIAL_API_KEY
            stats["official_api_requests"] += 1
            logger.info(f"[{request_id}] ✅ 检测到 tools 字段 → 官方 API (模型: {original_model})")
            if DEBUG_MODE:
                logger.debug(f"[{request_id}] Tools: {json.dumps(request_data['tools'], ensure_ascii=False)}")
        else:
            target_url = REVERSE_API_URL
            api_key = REVERSE_API_KEY
            stats["reverse_api_requests"] += 1
            # 替换为逆向 API 的固定模型
            request_data["model"] = REVERSE_API_MODEL
            logger.info(f"[{request_id}] ⚡ 无 tools 字段 → 逆向 API (模型: {original_model} → {REVERSE_API_MODEL})")

        # 检测是否为流式请求
        is_stream = request_data.get("stream", False)
        logger.info(f"[{request_id}] 流式模式: {is_stream}")

        # 转发请求
        return await forward_request(target_url, api_key, request_data, dict(request.headers), is_stream)

    except json.JSONDecodeError as e:
        logger.error(f"[{request_id}] JSON 解析失败: {str(e)}")
        stats["errors"] += 1
        return Response(content=json.dumps({"error": "Invalid JSON"}), status_code=400, media_type="application/json")
    except Exception as e:
        logger.error(f"[{request_id}] 处理请求失败: {str(e)}")
        stats["errors"] += 1
        return Response(content=json.dumps({"error": str(e)}), status_code=500, media_type="application/json")


@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "ok", "message": "API Proxy is running"}


@app.get("/stats")
async def get_stats():
    """获取统计信息"""
    return {
        "stats": stats,
        "config": {
            "official_api": OFFICIAL_API_URL,
            "reverse_api": REVERSE_API_URL,
            "debug_mode": DEBUG_MODE
        }
    }


@app.get("/debug/config")
async def debug_config():
    """调试：查看配置（隐藏敏感信息）"""
    return {
        "official_api_url": OFFICIAL_API_URL,
        "reverse_api_url": REVERSE_API_URL,
        "reverse_api_model": REVERSE_API_MODEL,
        "official_api_key_set": bool(OFFICIAL_API_KEY),
        "reverse_api_key_set": bool(REVERSE_API_KEY),
        "debug_mode": DEBUG_MODE
    }


if __name__ == "__main__":
    import uvicorn
    logger.info("🚀 启动 AI API 智能路由代理...")
    logger.info(f"📍 监听地址: http://localhost:8000")
    logger.info(f"✅ 官方 API: {OFFICIAL_API_URL}")
    logger.info(f"✅ 逆向 API: {REVERSE_API_URL}")
    logger.info(f"🔍 调试模式: {'开启' if DEBUG_MODE else '关闭'}")
    logger.info(f"📊 统计接口: http://localhost:8000/stats")
    logger.info(f"🔧 配置检查: http://localhost:8000/debug/config")
    uvicorn.run(app, host="0.0.0.0", port=8000)
