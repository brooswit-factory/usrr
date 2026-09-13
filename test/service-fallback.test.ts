import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderAvailabilityRegistry, type ManagedAgentProvider } from "@brooswit/drovr";
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
    return { conversationId: id ?? `${provider}-native`, response: "ok" };
  } });
  return { dir, path, transcript, availability, calls, runner };
}

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

test("blocked provider starts fresh with persisted history and unchanged workspace", async () => {
  const f = await fixture();
  await f.transcript.append({ role: "user", text: "remember the plan" });
  await f.transcript.append({ role: "assistant", text: "the plan is preserved" });
  f.availability.markQuotaBlocked({ provider: "agy", accountId: "usrr-personal" }, { resetsAt: null, raw: "explicit account state" });
  const service = new UsrrService({ ...emptyState(), provider: "agy", conversationId: "old-native", status: "idle" }, f.path, f.runner, f.transcript, ["agy", "codex", "claude"], f.availability, f.dir);
  const followed: string[] = [];
  const unsubscribe = service.follow(event => followed.push(event.role));
  expect((await service.message("continue", true)).ok).toBe(true);
  unsubscribe();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.provider).toBe("codex");
  expect(f.calls[0]!.id).toBeUndefined();
  expect(f.calls[0]!.text).toContain("NEW conversation");
  expect(f.calls[0]!.text).toContain("remember the plan");
  expect(f.calls[0]!.text).toContain(f.dir);
  expect(f.calls[0]!.text).not.toContain("old-native");
  expect(followed).toEqual(["user", "handoff", "assistant"]);
  expect(await loadState(f.path)).toMatchObject({ provider: "codex", conversationId: "codex-native" });
  const reopened = await TranscriptStore.open(join(f.dir, "transcript.jsonl"));
  expect((await reopened.history(10)).find(event => event.role === "handoff")?.text).toContain("old-native");
});

test("failed handoff retains old ID and never infers quota from arbitrary errors", async () => {
  const f = await fixture();
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
