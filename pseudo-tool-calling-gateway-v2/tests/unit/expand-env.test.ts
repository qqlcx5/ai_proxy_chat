import { describe, it, expect } from "vitest";
import { expandEnv } from "../../src/config/gateway.js";

describe("expandEnv", () => {
  it("expands a single ${VAR}", () => {
    process.env.FOO = "bar";
    expect(expandEnv("hello ${FOO}!")).toBe("hello bar!");
  });

  it("uses default when var is unset", () => {
    delete process.env.NOT_SET_X;
    expect(expandEnv("x=${NOT_SET_X:-fallback}")).toBe("x=fallback");
  });

  it("uses default when var is empty string", () => {
    process.env.EMPTY_VAR = "";
    expect(expandEnv("v=${EMPTY_VAR:-d}")).toBe("v=d");
  });

  it("expands to empty when var is unset and no default", () => {
    delete process.env.REALLY_MISSING;
    expect(expandEnv("a${REALLY_MISSING}b")).toBe("ab");
  });

  it("does not touch text without placeholders", () => {
    expect(expandEnv("plain text")).toBe("plain text");
  });

  it("handles multiple placeholders in one string", () => {
    process.env.A = "1";
    process.env.B = "2";
    expect(expandEnv("${A}-${B}-${MISSING:-x}")).toBe("1-2-x");
  });

  it("ignores lowercase vars (only UPPER_SNAKE)", () => {
    process.env.lowercase = "x";
    expect(expandEnv("${lowercase}")).toBe("${lowercase}");
  });
});
