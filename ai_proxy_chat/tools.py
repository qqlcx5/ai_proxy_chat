"""工具注册表。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from httpx import AsyncClient


@dataclass
class Tool:
    name: str
    description: str
    fn: callable


async def search(query: str) -> dict[str, Any]:
    """简单的搜索模拟。"""
    return {"results": [f"fake result for {query}"]}


async def get_weather(city: str) -> dict[str, Any]:
    """模拟天气查询。"""
    async with AsyncClient() as client:
        resp = await client.get(
            f"https://wttr.in/{city}?format=%C+%t",
            timeout=10,
        )
        return {"city": city, "weather": resp.text.strip()}


TOOLS: dict[str, Tool] = {
    "search": Tool(
        name="search",
        description="搜索互联网信息",
        fn=search,
    ),
    "get_weather": Tool(
        name="get_weather",
        description="查询城市天气",
        fn=get_weather,
    ),
}