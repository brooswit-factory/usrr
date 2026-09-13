import { afterEach, expect, test } from "bun:test";
import { ManagedConversationRunner, type RunProcess } from "@brooswit/drovr";
import { conversationRunner } from "../src/conversation";

const originalMode = process.env["USRR_AGY_PERMISSION_MODE"];
afterEach(() => {
  if (originalMode === undefined) delete process.env["USRR_AGY_PERMISSION_MODE"];
  else process.env["USRR_AGY_PERMISSION_MODE"] = originalMode;
});

test("USRR delegates structured message/resume to Drovr with native provider and exact cwd", async () => {
  process.env["USRR_AGY_PERMISSION_MODE"] = "plan";
  for (const provider of ["agy", "codex", "claude"] as const) {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const run: RunProcess = async (argv, cwd) => {
      calls.push({ argv, cwd });
      const stdout = provider === "agy"
        ? JSON.stringify({ status: "SUCCESS", conversation_id: "native-id", response: "ok" })
        : provider === "claude"
          ? JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "native-id", result: "ok" })
          : [
            { type: "thread.started", thread_id: "native-id" },
            { type: "item.completed", item: { type: "agent_message", text: "ok" } },
            { type: "turn.completed" },
          ].map(event => JSON.stringify(event)).join("\n");
      return { exitCode: 0, stdout, stderr: "" };
    };
    const runner = conversationRunner(provider, "/work/personal", run);
    expect(runner).toBeInstanceOf(ManagedConversationRunner);
    expect(await runner.message("hello")).toEqual({ conversationId: "native-id", response: "ok" });
    expect(await runner.message("continue", "native-id")).toEqual({ conversationId: "native-id", response: "ok" });
    expect(calls.map(call => call.cwd)).toEqual(["/work/personal", "/work/personal"]);
    expect(calls.every(call => call.argv[0] === provider)).toBe(true);
    expect(calls[0]!.argv).not.toContain("native-id");
    expect(calls[1]!.argv).toContain("native-id");
    expect(calls.flatMap(call => call.argv).some(arg => arg.includes("mcp_servers") || arg.includes("butchr"))).toBe(false);
    expect(runner.attachArgv("native-id")).toEqual(new ManagedConversationRunner({ provider, cwd: "/work/personal", permissionMode: "plan" }).attachArgv("native-id"));
  }
});

test("legacy permission mode is supplied unchanged and default remains accept-edits", () => {
  for (const mode of [undefined, "plan", "yolo"] as const) {
    if (mode === undefined) delete process.env["USRR_AGY_PERMISSION_MODE"];
    else process.env["USRR_AGY_PERMISSION_MODE"] = mode;
    const runner = conversationRunner("agy", "/work/personal");
    expect(runner.attachArgv("native-id")).toEqual(new ManagedConversationRunner({ provider: "agy", cwd: "/work/personal", permissionMode: mode ?? "accept-edits" }).attachArgv("native-id"));
  }
});
