"""Test gateway tool execution locally."""

import asyncio
import sys
from pathlib import Path

# Add current dir to path
sys.path.insert(0, str(Path(__file__).parent))

from gateway import execute_tool, _exec_read, _exec_write, WORKSPACE

async def test_tools():
    print(f"Workspace: {WORKSPACE.absolute()}\n")

    # Test 1: Write a file
    print("Test 1: Write file")
    result = await execute_tool("write", {
        "path": "test_file.txt",
        "content": "Hello from gateway tool test!"
    })
    print(f"  Result: {result}\n")

    # Test 2: Read the file
    print("Test 2: Read file")
    result = await execute_tool("read", {"path": "test_file.txt"})
    print(f"  Result: {result}\n")

    # Test 3: Edit the file
    print("Test 3: Edit file")
    result = await execute_tool("edit", {
        "path": "test_file.txt",
        "old": "Hello",
        "new": "Hi"
    })
    print(f"  Result: {result}\n")

    # Test 4: Read again
    print("Test 4: Read edited file")
    result = await execute_tool("read", {"path": "test_file.txt"})
    print(f"  Result: {result}\n")

    # Test 5: Exec command
    print("Test 5: Execute command")
    result = await execute_tool("exec", {"command": "echo 'Command test'"})
    print(f"  Result: {result}\n")

    # Test 6: Web search
    print("Test 6: Web search")
    result = await execute_tool("web_search", {"query": "Python programming"})
    print(f"  Result: {result[:200]}...\n")

    # Cleanup
    print("Cleanup: Removing test file")
    (WORKSPACE / "test_file.txt").unlink(missing_ok=True)
    print("OK - All tests completed")

if __name__ == "__main__":
    asyncio.run(test_tools())
