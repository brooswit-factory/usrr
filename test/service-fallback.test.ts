import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HANDOFF_ACK, NativeTranscriptUnavailableError, ProviderAvailabilityRegistry, type ManagedAgentProvider } from "@brooswit/drovr";
import { UsrrService, type ConversationFactory } from "../src/service";
import { emptyState, loadState } from "../src/state";
import { TranscriptStore } from "../src/transcript";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "usrr-fallback-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  const transcript = await TranscriptStore.open(join(dir, "transcript.jsonl"));
  const availability = new ProviderAvailabilityRegistry();
  const calls: Array<{ provider: ManagedAgentProvider; text: string; id: string | undefined }> = [];
  const runner: ConversationFactory = provider => ({ message: async (text, id) => {
    calls.push({ provider, text, id });
    return { conversationId: id ?? `${provider}-native`, response: `${HANDOFF_ACK}\nImported context` };
  } });
  return { dir, path, transcript, availability, calls, runner };
}

test("interactive native history feeds both history API and automatic handoff", async () => {
  const f = await fixture();
  const nativeTranscript = "interactive-only oldest " + "x".repeat(60_000) + " newest";
  const service = new UsrrService({ ...emptyState(), provider: "agy", conversationId: "old-native", status: "idle" },
    f.path, f.runner, f.transcript, undefined, f.availability, f.dir, async options => {
      expect(options.session.value).toBe("old-native");
      return nativeTranscript;
    });
  expect(await service.history(1)).toEqual({ ok: true, result: { events: [], nativeTranscript } });
  f.availability.markQuotaBlocked({ provider: "agy", accountId: "usrr-personal" }, { resetsAt: null, raw: "confirmed" });
  expect((await service.message("pending-native-task", true)).ok).toBe(true);
  expect(f.calls).toHaveLength(3);
  expect(f.calls[0]!.text).toContain("interactive-only oldest");
  expect(f.calls[1]!.text).toContain("newest");
  expect(f.calls[0]!.text + f.calls[1]!.text).not.toContain("pending-native-task");
  expect(f.calls[2]).toEqual({ provider: "codex", text: "pending-native-task", id: "codex-native" });
});

test("history falls back only for unavailable native files", async () => {
  const f = await fixture();
  await f.transcript.append({ role: "user", text: "journal-only" });
  for (const missing of [true, false]) {
    const service = new UsrrService({ ...emptyState(), provider: "agy", conversationId: "old-native", status: "idle" },
      f.path, f.runner, f.transcript, undefined, f.availability, f.dir, async () => {
        throw missing ? new NativeTranscriptUnavailableError() : new Error("malformed native history");
      });
    if (missing) expect(await service.history(1)).toMatchObject({ ok: true, result: { events: [{ text: "journal-only" }] } });
    else await expect(service.history(1)).rejects.toThrow("malformed native history");
  }
});

test("each native provider stays pinned across restart despite preference changes", async () => {
  for (const provider of ["agy", "codex", "claude"] as const) {
    const f = await fixture();
    const service = new UsrrService(emptyState(), f.path, f.runner, f.transcript, [provider]);
    expect((await service.message("new", true)).ok).toBe(true);
    const restarted = new UsrrService(await loadState(f.path), f.path, f.runner, f.transcript, ["agy", "codex", "claude"]);
    expect((await restarted.message("continue", true)).ok).toBe(true);
    expect(f.calls.map(call => call.provider)).toEqual([provider, provider]);
    expect(f.calls[1]!.id).toBe(`${provider}-native`);
    expect(restarted.status().provider).toBe(provider);
    expect(restarted.attachTarget()).toEqual({ ok: true, result: { provider, conversationId: `${provider}-native` } });
  }
});

test("blocked provider compacts full persisted history then resumes pending work after commit", async () => {
  const f = await fixture();
  await f.transcript.append({ role: "user", text: "remember the plan" });
  await f.transcript.append({ role: "assistant", text: "the plan is preserved" });
  for (let i = 0; i < 30; i++) await f.transcript.append({ role: i % 2 ? "assistant" : "user", text: `history-${i}` });
  f.availability.markQuotaBlocked({ provider: "agy", accountId: "usrr-personal" }, { resetsAt: null, raw: "explicit account state" });
  const runner: ConversationFactory = provider => ({ message: async (text, id) => {
    if (text === "pending-task-unique") expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "codex-native", status: "working" });
    return f.runner(provider).message(text, id);
  } });
  const service = new UsrrService({ ...emptyState(), provider: "agy", conversationId: "old-native", status: "idle" }, f.path, runner, f.transcript, ["agy", "codex", "claude"], f.availability, f.dir);
  const followed: string[] = [];
  const unsubscribe = service.follow(event => followed.push(event.role));
  expect((await service.message("pending-task-unique", true)).ok).toBe(true);
  unsubscribe();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]!.provider).toBe("codex");
  expect(f.calls[0]!.id).toBeUndefined();
  expect(f.calls[0]!.text).not.toContain("pending-task-unique");
  expect(f.calls[0]!.text).toContain("remember the plan");
  expect(f.calls[0]!.text).toContain("history-29");
  expect(f.calls[0]!.text).toContain(f.dir);
  expect(f.calls[0]!.text).not.toContain("old-native");
  expect(f.calls[1]).toEqual({ provider: "codex", text: "pending-task-unique", id: "codex-native" });
  expect(followed).toEqual(["user", "handoff", "assistant"]);
  expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "codex-native" });
  const reopened = await TranscriptStore.open(join(f.dir, "transcript.jsonl"));
  expect((await reopened.history(10)).find(event => event.role === "handoff")?.text).toContain("old-native");
});

test("failed handoff retains old ID and never infers quota from arbitrary errors", async () => {
  const f = await fixture();
  const user = await f.transcript.append({ role: "user", text: "Continue the workspace migration after verification." });
  await f.transcript.append({ role: "assistant", text: "The migration is prepared and awaits verification.", replyTo: user.sequence });
  f.availability.markQuotaBlocked({ provider: "agy", accountId: "usrr-personal" }, { resetsAt: null, raw: "explicit account state" });
  const called: ManagedAgentProvider[] = [];
  const runner: ConversationFactory = provider => ({ message: async () => { called.push(provider); throw new Error("quota exceeded in tool output"); } });
  const service = new UsrrService({ ...emptyState(), provider: "agy", conversationId: "old-native", status: "idle" }, f.path, runner, f.transcript, ["agy", "codex", "claude"], f.availability, f.dir);
  expect((await service.message("continue", true)).ok).toBe(false);
  expect(called).toEqual(["codex"]);
  expect(await loadState(f.path)).toMatchObject({ provider: "agy", conversationId: "old-native", status: "error" });
  expect(service.attachTarget()).toEqual({ ok: true, result: { provider: "agy", conversationId: "old-native" } });
  expect(f.availability.get({ provider: "codex", accountId: "usrr-personal" }).status).toBe("available");
});

test("default order reaches Claude only when Antigravity and Codex are explicitly unavailable", async () => {
  const f = await fixture();
  for (const provider of ["agy", "codex"] as const) {
    f.availability.markQuotaBlocked({ provider, accountId: "usrr-personal" }, { resetsAt: null, raw: "explicit test account state" });
  }
  const service = new UsrrService(emptyState(), f.path, f.runner, f.transcript, undefined, f.availability);
  expect((await service.message("continue", true)).ok).toBe(true);
  expect(f.calls.map(call => call.provider)).toEqual(["claude"]);
  expect(await loadState(f.path)).toMatchObject({ provider: "claude", conversationId: "claude-native" });
});

test("all exhausted does not launch or discard native conversation", async () => {
  const f = await fixture();
  for (const provider of ["agy", "codex", "claude"] as const) f.availability.markQuotaBlocked({ provider, accountId: "usrr-personal" }, { resetsAt: null, raw: "explicit account state" });
  const service = new UsrrService({ ...emptyState(), conversationId: "legacy", status: "idle" }, f.path, f.runner, f.transcript, undefined, f.availability);
  const result = await service.message("continue", true);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("exhausted");
  expect(f.calls).toEqual([]);
  expect((await loadState(f.path)).conversationId).toBe("legacy");
});

test("response transcript failure retains the newly created native conversation", async () => {
  const f = await fixture();
  const append = f.transcript.append.bind(f.transcript);
  f.transcript.append = async event => {
    if (event.role === "assistant") throw new Error("transcript write failed");
    return append(event);
  };
  const service = new UsrrService(emptyState(), f.path, f.runner, f.transcript, ["codex"]);
  expect((await service.message("new conversation", true)).ok).toBe(false);
  expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "codex-native", status: "error" });
  expect(service.attachTarget()).toEqual({ ok: true, result: { provider: "codex", conversationId: "codex-native" } });
});

test("pending task failure after acknowledged fallback retains the committed target", async () => {
  const f = await fixture();
  const user = await f.transcript.append({ role: "user", text: "Prepare the migration and retain the existing files." });
  await f.transcript.append({ role: "assistant", text: "Preparation is complete; the next task is verification.", replyTo: user.sequence });
  f.availability.markQuotaBlocked({ provider: "agy", accountId: "usrr-personal" }, { resetsAt: null, raw: "explicit account state" });
  const runner: ConversationFactory = provider => ({ message: async (text, id) => {
    if (text === "pending task") {
      expect(id).toBe("codex-native");
      expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "codex-native" });
      const record = (await f.transcript.history()).find(event => event.role === "handoff")!;
      expect(JSON.parse(record.text)).toMatchObject({ reason: "USRR provider fallback", previous: { provider: "agy", conversationId: "old-native" } });
      throw new Error("task failed after handoff");
    }
    return f.runner(provider).message(text, id);
  } });
  const service = new UsrrService({ ...emptyState(), provider: "agy", conversationId: "old-native", status: "idle" }, f.path, runner, f.transcript, undefined, f.availability);
  expect((await service.message("pending task", true)).ok).toBe(false);
  expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "codex-native", status: "error" });
  expect(service.attachTarget()).toEqual({ ok: true, result: { provider: "codex", conversationId: "codex-native" } });
});
