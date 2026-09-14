import { afterEach, expect, test } from "bun:test";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_ACK, ProviderAvailabilityRegistry } from "@brooswit/drovr";
import { UsrrService, type ConversationFactory } from "../src/service";
import { emptyState, loadState } from "../src/state";
import { TranscriptStore } from "../src/transcript";
import { startApiServer } from "../src/api/server";
import { createApiClient } from "../src/cli/api-client";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(runner: ConversationFactory, withHistory = true) {
  const dir = await mkdtemp(join(tmpdir(), "usrr-switch-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  const transcript = await TranscriptStore.open(join(dir, "transcript.jsonl"));
  if (withHistory) {
    const user = await transcript.append({ role: "user", text: "Preserve the existing workspace and continue the migration plan." });
    await transcript.append({ role: "assistant", text: "The migration plan is recorded; verification remains outstanding.", replyTo: user.sequence });
  }
  const state = { ...emptyState(), provider: "agy" as const, conversationId: "old-native", status: "idle" as const };
  const service = new UsrrService(state, path, runner, transcript, undefined, new ProviderAvailabilityRegistry(), dir);
  return { dir, path, transcript, service };
}

test("explicit switch excludes other operations, commits after acknowledgment, and pins subsequent work", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<{ provider: string; text: string; id: string | undefined }> = [];
  const f = await fixture(provider => ({ message: async (text, id) => {
    calls.push({ provider, text, id });
    await gate;
    return { conversationId: id ?? "new-native", response: `${HANDOFF_ACK}\nSummary` };
  } }));
  const switching = f.service.switchProvider("codex");
  expect(await f.service.switchProvider("claude")).toMatchObject({ ok: false, error: { kind: "busy" } });
  expect(await f.service.message("collision", true)).toMatchObject({ ok: false, error: { kind: "busy" } });
  expect(f.service.attachTarget()).toMatchObject({ ok: false, error: { kind: "busy" } });
  expect(await f.service.waitUntilIdle(0)).toMatchObject({ ok: false, error: { kind: "busy" } });
  release();
  expect(await switching).toEqual({ ok: true, result: { provider: "codex", conversationId: "new-native" } });
  expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "new-native", status: "idle" });
  expect(calls).toHaveLength(1);
  const history = await f.transcript.history();
  expect(history).toHaveLength(3);
  expect(history[2]).toMatchObject({ sequence: 3, role: "handoff" });
  expect(JSON.parse(history[2]!.text)).toEqual({ reason: "Explicit USRR provider switch", previous: { provider: "agy", conversationId: "old-native" }, next: { provider: "codex", conversationId: "new-native" } });
  expect((await f.service.switchProvider("codex")).ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect((await f.service.message("next task", true)).ok).toBe(true);
  expect(calls[1]).toEqual({ provider: "codex", text: "next task", id: "new-native" });
});

test("missing compaction acknowledgment preserves previous session and clears busy guard", async () => {
  const f = await fixture(() => ({ message: async () => ({ conversationId: "unconfirmed", response: "ok" }) }));
  expect(await f.service.switchProvider("claude")).toMatchObject({ ok: false, error: { kind: "agent-failed" } });
  expect(await loadState(f.path)).toMatchObject({ provider: "agy", conversationId: "old-native", status: "error" });
  expect(f.service.attachTarget()).toEqual({ ok: true, result: { provider: "agy", conversationId: "old-native" } });
  expect((await f.service.waitUntilIdle(0)).ok).toBe(true);
});

test("handoff reads history from disk and passes all chunks before committing", async () => {
  const calls: Array<{ text: string; id: string | undefined }> = [];
  const f = await fixture(() => ({ message: async (text, id) => {
    calls.push({ text, id });
    expect(await loadState(f.path)).toMatchObject({ provider: "agy", conversationId: "old-native" });
    return { conversationId: "chunked", response: `${HANDOFF_ACK}\nSummary` };
  } }));
  const records = await f.transcript.history();
  records[0] = { ...records[0]!, text: "oldest-marker " + "x".repeat(60_000) + " newest-marker" };
  await writeFile(join(f.dir, "transcript.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  expect((await f.service.switchProvider("claude")).ok).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.text).toContain("oldest-marker");
  expect(calls[0]!.id).toBeUndefined();
  expect(calls[1]!.text).toContain("newest-marker");
  expect(calls[1]!.id).toBe("chunked");
  expect(await loadState(f.path)).toMatchObject({ provider: "claude", conversationId: "chunked" });
});

test("recovery transcript write failure prevents committing the target", async () => {
  const f = await fixture(() => ({ message: async () => ({ conversationId: "uncommitted", response: `${HANDOFF_ACK}\nSummary` }) }));
  f.transcript.append = async () => { throw new Error("recovery write failed"); };
  expect((await f.service.switchProvider("codex")).ok).toBe(false);
  expect(await loadState(f.path)).toMatchObject({ provider: "agy", conversationId: "old-native", status: "error" });
});

test("missing history preserves the old session without launching a target", async () => {
  let launches = 0;
  const f = await fixture(() => {
    launches++;
    return { message: async () => ({ conversationId: "unexpected", response: `${HANDOFF_ACK}\nSummary` }) };
  }, false);
  expect(await f.service.switchProvider("codex")).toMatchObject({ ok: false, error: { kind: "agent-failed" } });
  expect(launches).toBe(0);
  expect(await loadState(f.path)).toMatchObject({ provider: "agy", conversationId: "old-native", status: "error" });
  expect(await f.transcript.history()).toEqual([]);
  expect(f.service.attachTarget()).toEqual({ ok: true, result: { provider: "agy", conversationId: "old-native" } });
  expect((await f.service.waitUntilIdle(0)).ok).toBe(true);
});

test("switch API validates providers and exposes committed session through the client", async () => {
  const f = await fixture(() => ({ message: async () => ({ conversationId: "api-native", response: `${HANDOFF_ACK}\nSummary` }) }));
  const socket = join(f.dir, "api.sock");
  const server = await startApiServer(f.service, socket);
  if (!server.ok) throw new Error(server.error);
  try {
    const invalid = await fetch("http://localhost/v1/switch", { unix: socket, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "other" }) });
    expect(invalid.status).toBe(400);
    const client = createApiClient(socket);
    expect(await client.switchProvider("claude")).toMatchObject({ transport: "ok", status: 200, body: { ok: true, result: { provider: "claude", conversationId: "api-native" } } });
    expect(await client.attachTarget()).toMatchObject({ transport: "ok", body: { ok: true, result: { provider: "claude", conversationId: "api-native" } } });
  } finally { server.handle.stop(); }
});
