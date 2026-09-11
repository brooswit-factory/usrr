import { describe, expect, test } from "bun:test";
import { AgyRunner, type RunProcess } from "../src/agy";

describe("AgyRunner", () => {
  test("starts a new conversation and parses the result", async () => {
    let seen: readonly string[] = [];
    const run: RunProcess = async (argv) => {
      seen = argv;
      return { exitCode: 0, stdout: JSON.stringify({ conversation_id: "conversation-1", status: "SUCCESS", response: "ready" }), stderr: "" };
    };
    const result = await new AgyRunner("/tmp", run, "plan").message("hello");
    expect(result).toEqual({ conversationId: "conversation-1", response: "ready" });
    expect(seen).toEqual(["agy", "--mode", "plan", "--output-format", "json", "--print", "hello"]);
  });

  test("resumes the durable conversation", async () => {
    let seen: readonly string[] = [];
    const run: RunProcess = async (argv) => {
      seen = argv;
      return { exitCode: 0, stdout: JSON.stringify({ conversation_id: "conversation-1", status: "SUCCESS", response: "again" }), stderr: "" };
    };
    await new AgyRunner("/tmp", run).message("continue", "conversation-1");
    expect(seen).toContain("--conversation");
    expect(seen).toContain("conversation-1");
  });

  test("surfaces Antigravity failures", async () => {
    const run: RunProcess = async () => ({ exitCode: 1, stdout: "", stderr: "quota exhausted" });
    expect(new AgyRunner("/tmp", run).message("hello")).rejects.toThrow("quota exhausted");
  });
});
