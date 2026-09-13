import { describe, expect, test } from "bun:test";
import type { ApiClient, CallResult } from "../src/cli/api-client";
import { runCli, type CliIO } from "../src/cli/main";
import type { TranscriptEvent } from "../src/transcript";

const events: TranscriptEvent[] = [
  { version: 1, sequence: 1, timestamp: "2026-09-11T00:00:00.000Z", role: "user", text: "hello" },
  { version: 1, sequence: 2, timestamp: "2026-09-11T00:00:01.000Z", role: "assistant", text: "hi", replyTo: 1 },
];

function successful<T>(body: T): Promise<CallResult<T>> {
  return Promise.resolve({ transport: "ok", status: 200, body });
}

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    status: () => successful({ ok: true, result: { status: "idle", updatedAt: "now" } }),
    message: () => successful({ ok: true, result: { accepted: true } }),
    wait: () => successful({ ok: true, result: { status: "idle", updatedAt: "now" } }),
    attachTarget: () => successful({ ok: true, result: { conversationId: "conversation" } }),
    history: () => successful({ ok: true, result: { events } }),
    follow: async (onEvent) => {
      for (const event of events) onEvent(event);
      return { transport: "ok", status: 200, body: undefined };
    },
    ...overrides,
  };
}

function fakeIo(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
      attach: async () => 0,
    },
  };
}

describe("history and follow CLI", () => {
  test("attach uses the daemon's native provider, defaulting legacy targets to AGY", async () => {
    for (const provider of [undefined, "agy", "codex", "claude"] as const) {
      const { io } = fakeIo();
      const calls: unknown[] = [];
      const terminal: CliIO = { ...io, stdinIsTTY: true, stdoutIsTTY: true, attach: async (id, selected) => { calls.push([id, selected]); return 0; } };
      const api = fakeApi({ attachTarget: () => successful({ ok: true, result: { conversationId: "native", ...(provider ? { provider } : {}) } }) });
      expect(await runCli(["attach"], api, terminal)).toBe(0);
      expect(calls).toEqual([["native", provider ?? "agy"]]);
    }
  });
  test("renders human history", async () => {
    const { io, stdout } = fakeIo();
    expect(await runCli(["history", "2"], fakeApi(), io)).toBe(0);
    const rendered = stdout.join("");
    expect(rendered).toContain("USER #1\nhello");
    expect(rendered).toContain("ASSISTANT #2 reply-to=1\nhi");
  });

  test("renders history as a JSON array", async () => {
    const { io, stdout } = fakeIo();
    expect(await runCli(["history", "--json"], fakeApi(), io)).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual(events);
  });

  test("streams follow events as NDJSON", async () => {
    const { io, stdout } = fakeIo();
    expect(await runCli(["follow", "--json"], fakeApi(), io)).toBe(0);
    const parsed = stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(parsed).toEqual(events);
  });
});
