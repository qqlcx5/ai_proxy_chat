import { describe, it, expect } from "vitest";
import { flattenContext } from "../../src/engine/flattener.js";
import type { InternalRequest } from "../../src/protocol/types.js";

function req(msgs: InternalRequest["messages"]): InternalRequest {
  return {
    model: "gpt-5.6-luna",
    systemPrompt: "be helpful",
    messages: msgs,
    tools: [],
    stream: true,
    protocol: "openai-chat",
  };
}

describe("flatten", () => {
  it("truncates large tool_result text", () => {
    const big = "x".repeat(5000);
    const r = flattenContext(req([{ role: "tool_result", text: big, toolName: "read" }]), "");
    const sys = r[0]!;
    expect(sys.role).toBe("system");
    const user = r[1]!;
    expect(user.role).toBe("user");
    expect(user.content).toContain("truncated");
    expect(user.content).toContain("read");
    expect(user.content.length).toBeLessThan(big.length);
  });

  it("renders recent user/assistant history as [user]/[assistant] tags", () => {
    const r = flattenContext(
      req([
        { role: "user", text: "earlier" },
        { role: "assistant", text: "ok" },
        { role: "user", text: "now" },
      ]),
      "",
    );
    const content = r[1]!.content;
    expect(content).toContain("[user] earlier");
    expect(content).toContain("[assistant] ok");
    expect(content).toContain("[user] now");
  });

  it("injects toolPrompt as a leading block when present", () => {
    const r = flattenContext(req([{ role: "user", text: "now" }]), "TOOL_INJECT");
    expect(r[1]!.content.startsWith("TOOL_INJECT")).toBe(true);
  });
});
