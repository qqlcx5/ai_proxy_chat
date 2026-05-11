"""AI Proxy Chat —— 入口点。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from .orchestrator import run


async def main() -> None:
    print("AI Proxy Chat (输入 exit 退出)")
    while True:
        try:
            prompt = input("\n>>> ")
        except (EOFError, KeyboardInterrupt):
            break

        if prompt.strip().lower() in ("exit", "quit"):
            break

        answer = await run(prompt)
        print(f"\n{answer}")


if __name__ == "__main__":
    asyncio.run(main())