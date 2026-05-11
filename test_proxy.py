"""
API 代理测试脚本
用于测试路由逻辑和 API 连通性
"""
import requests
import json
import time

BASE_URL = "http://localhost:8000"


def print_section(title):
    """打印分隔线"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")


def test_health():
    """测试健康检查"""
    print_section("1. 健康检查")
    try:
        response = requests.get(f"{BASE_URL}/health")
        print(f"状态码: {response.status_code}")
        print(f"响应: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")
        return response.status_code == 200
    except Exception as e:
        print(f"❌ 错误: {str(e)}")
        return False


def test_config():
    """测试配置检查"""
    print_section("2. 配置检查")
    try:
        response = requests.get(f"{BASE_URL}/debug/config")
        print(f"状态码: {response.status_code}")
        print(f"配置信息:")
        config = response.json()
        for key, value in config.items():
            print(f"  {key}: {value}")
        return True
    except Exception as e:
        print(f"❌ 错误: {str(e)}")
        return False


def test_no_tools_request():
    """测试无 tools 的请求（应路由到逆向 API）"""
    print_section("3. 测试无 tools 请求（逆向 API）")
    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": "Hello, how are you?"}
        ],
        "max_tokens": 100
    }

    print("请求体:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("\n预期路由: 逆向 API ⚡")

    try:
        response = requests.post(f"{BASE_URL}/chat", json=payload)
        print(f"\n状态码: {response.status_code}")
        if response.status_code == 200:
            print("✅ 请求成功")
            print(f"响应预览: {response.text[:200]}...")
        else:
            print(f"❌ 请求失败: {response.text}")
        return response.status_code == 200
    except Exception as e:
        print(f"❌ 错误: {str(e)}")
        return False


def test_with_tools_request():
    """测试有 tools 的请求（应路由到官方 API）"""
    print_section("4. 测试有 tools 请求（官方 API）")
    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": "What files are in the current directory?"}
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
    }

    print("请求体:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("\n预期路由: 官方 API ✅")

    try:
        response = requests.post(f"{BASE_URL}/chat", json=payload)
        print(f"\n状态码: {response.status_code}")
        if response.status_code == 200:
            print("✅ 请求成功")
            print(f"响应预览: {response.text[:200]}...")
        else:
            print(f"❌ 请求失败: {response.text}")
        return response.status_code == 200
    except Exception as e:
        print(f"❌ 错误: {str(e)}")
        return False


def test_stats():
    """查看统计信息"""
    print_section("5. 统计信息")
    try:
        response = requests.get(f"{BASE_URL}/stats")
        print(f"状态码: {response.status_code}")
        print(f"统计数据:")
        stats = response.json()
        print(json.dumps(stats, indent=2, ensure_ascii=False))
        return True
    except Exception as e:
        print(f"❌ 错误: {str(e)}")
        return False


def test_stream_request():
    """测试流式请求"""
    print_section("6. 测试流式请求")
    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": "Count from 1 to 5"}
        ],
        "max_tokens": 50,
        "stream": True
    }

    print("请求体:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("\n预期: 流式响应")

    try:
        response = requests.post(f"{BASE_URL}/chat", json=payload, stream=True)
        print(f"\n状态码: {response.status_code}")
        if response.status_code == 200:
            print("✅ 开始接收流式数据...")
            chunk_count = 0
            for chunk in response.iter_content(chunk_size=None):
                if chunk:
                    chunk_count += 1
                    print(f"  收到数据块 {chunk_count}: {len(chunk)} bytes")
                    if chunk_count >= 3:  # 只显示前3个块
                        print("  ...")
                        break
            print(f"✅ 流式请求成功（共 {chunk_count}+ 个数据块）")
        else:
            print(f"❌ 请求失败: {response.text}")
        return response.status_code == 200
    except Exception as e:
        print(f"❌ 错误: {str(e)}")
        return False


def main():
    """运行所有测试"""
    print("\n" + "="*60)
    print("  🧪 API 代理测试套件")
    print("="*60)

    results = []

    # 运行测试
    results.append(("健康检查", test_health()))
    time.sleep(0.5)

    results.append(("配置检查", test_config()))
    time.sleep(0.5)

    results.append(("无 tools 请求", test_no_tools_request()))
    time.sleep(0.5)

    results.append(("有 tools 请求", test_with_tools_request()))
    time.sleep(0.5)

    results.append(("流式请求", test_stream_request()))
    time.sleep(0.5)

    results.append(("统计信息", test_stats()))

    # 汇总结果
    print_section("测试结果汇总")
    passed = sum(1 for _, result in results if result)
    total = len(results)

    for name, result in results:
        status = "✅ 通过" if result else "❌ 失败"
        print(f"{status}  {name}")

    print(f"\n总计: {passed}/{total} 通过")

    if passed == total:
        print("\n🎉 所有测试通过！代理服务运行正常。")
    else:
        print(f"\n⚠️  有 {total - passed} 个测试失败，请检查日志。")


if __name__ == "__main__":
    main()
