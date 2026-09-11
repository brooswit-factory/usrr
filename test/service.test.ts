import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgyRunner, type RunProcess } from "../src/agy";
import { UsrrService } from "../src/service";
import { emptyState } from "../src/state";
import { TranscriptStore } from "../src/transcript";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("UsrrService", () => {
  test("persists and resumes one durable conversation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usrr-test-"));
    dirs.push(dir);
    const calls: string[][] = [];
    const run: RunProcess = async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: JSON.stringify({ conversation_id: "durable", status: "SUCCESS", response: "ok" }), stderr: "" };
    };
    const path = join(dir, "state.json");
    const transcript = await TranscriptStore.open(join(dir, "transcript.jsonl"));
    const service = new UsrrService(emptyState(), path, new AgyRunner(dir, run), transcript);
    expect((await service.message("hello", true)).ok).toBe(true);
    expect((await service.message("again", true)).ok).toBe(true);
    expect(calls[1]).toContain("durable");
    expect(JSON.parse(await readFile(path, "utf8")).status).toBe("idle");
  });

  test("reports busy and settles an asynchronous message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usrr-test-"));
    dirs.push(dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run: RunProcess = async () => {
      await gate;
      return { exitCode: 0, stdout: JSON.stringify({ conversation_id: "durable", status: "SUCCESS", response: "ok" }), stderr: "" };
    };
    const transcript = await TranscriptStore.open(join(dir, "transcript.jsonl"));
    const service = new UsrrService(emptyState(), join(dir, "state.json"), new AgyRunner(dir, run), transcript);
    expect(await service.message("hello", false)).toEqual({ ok: true, result: { accepted: true } });
    expect(service.status().status).toBe("working");
    const acceptedHistory = await service.history(10);
    expect(acceptedHistory.ok && acceptedHistory.result.events).toEqual([
      expect.objectContaining({ sequence: 1, role: "user", text: "hello" }),
    ]);
    expect((await service.message("collision", true)).ok).toBe(false);
    release();
    expect((await service.waitUntilIdle(1000)).ok).toBe(true);
    const history = await service.history(10);
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error(history.error.message);
    expect(history.result).toEqual({
      events: [
        expect.objectContaining({ sequence: 1, role: "user", text: "hello" }),
        expect.objectContaining({ sequence: 2, role: "assistant", text: "ok", replyTo: 1 }),
      ],
    });
  });

  test("attach requires an established idle conversation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usrr-test-"));
    dirs.push(dir);
    const transcript = await TranscriptStore.open(join(dir, "transcript.jsonl"));
    const service = new UsrrService(emptyState(), join(dir, "state.json"), new AgyRunner("/tmp", async () => ({ exitCode: 1, stdout: "", stderr: "unused" })), transcript);
    expect(service.attachTarget()).toEqual({ ok: false, error: { kind: "absent", message: expect.any(String) } });
  });
});
