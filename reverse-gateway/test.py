#!/usr/bin/env python3
"""Test script for reverse gateway."""

import asyncio
import json

import httpx

BASE_URL = "http://localhost:8000"


async def test_simple_chat():
    """Test simple non-streaming chat."""
    print("\n=== Test 1: Simple Chat (Non-streaming) ===")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{BASE_URL}/v1/messages",
            json={
                "model": "gpt-5.2",
                "messages": [{"role": "user", "content": "Say hello in one sentence"}],
            },
        )
        print(f"Status: {resp.status_code}")
        data = resp.json()
        print(f"Response: {json.dumps(data, indent=2, ensure_ascii=False)}")


async def test_streaming_chat():
    """Test streaming chat."""
    print("\n=== Test 2: Streaming Chat ===")
    async with httpx.AsyncClient(timeout=30) as client:
        async with client.stream(
            "POST",
            f"{BASE_URL}/v1/messages",
            json={
                "model": "gpt-5.2",
                "messages": [{"role": "user", "content": "Count from 1 to 5"}],
                "stream": True,
            },
        ) as resp:
            print(f"Status: {resp.status_code}")
            print("Stream events:")
            async for line in resp.aiter_lines():
                if line.startswith("event: "):
                    print(f"  {line}")
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                    if data.get("type") == "content_block_delta":
                        text = data.get("delta", {}).get("text", "")
                        if text:
                            print(f"    Text: {text!r}")


async def test_tool_call():
    """Test tool calling."""
    print("\n=== Test 3: Tool Call (read file) ===")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{BASE_URL}/v1/messages",
            json={
                "model": "gpt-5.2",
                "messages": [
                    {"role": "user", "content": "帮我读取 README.md 文件的前 500 个字符"}
                ],
                "tools": [
                    {
                        "name": "read",
                        "description": "Read file",
                        "input_schema": {
                            "type": "object",
                            "properties": {"path": {"type": "string"}},
                            "required": ["path"],
                        },
                    }
                ],
            },
        )
        print(f"Status: {resp.status_code}")
        data = resp.json()
        print(f"Response: {json.dumps(data, indent=2, ensure_ascii=False)[:1000]}")


async def main():
    print("Starting reverse gateway tests...")
    print("Make sure the server is running on http://localhost:8000")

    try:
        await test_simple_chat()
        await test_streaming_chat()
        await test_tool_call()
        print("\n=== All tests completed ===")
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
