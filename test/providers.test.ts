import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_ORDER, providerOrder } from "../src/providers";
import { recoverState } from "../src/state";

describe("USRR provider preference", () => {
  test("defaults to antigravity, OpenAI, Claude and validates configurable order", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual(["agy", "codex", "claude"]);
    expect(providerOrder(" claude, agy, codex ")).toEqual(["claude", "agy", "codex"]);
    for (const value of ["", "agy,agy", "agy,", "gemini", "openai"]) expect(() => providerOrder(value)).toThrow("USRR_AGENT_PROVIDERS");
  });
  test("restart recovery retains native provider metadata", () => {
    expect(recoverState({ version: 1, conversationId: "existing", provider: "agy", status: "working", updatedAt: "before" }).provider).toBe("agy");
  });
});
