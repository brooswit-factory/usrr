import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../src/transcript";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function temporaryTranscript(): Promise<{ dir: string; path: string; store: TranscriptStore }> {
  const dir = await mkdtemp(join(tmpdir(), "usrr-transcript-test-"));
  dirs.push(dir);
  const path = join(dir, "state", "transcript.jsonl");
  return { dir, path, store: await TranscriptStore.open(path) };
}

describe("TranscriptStore", () => {
  test("persists ordered, linked events across restarts", async () => {
    const { path, store } = await temporaryTranscript();
    const user = await store.append({ role: "user", text: "hello" });
    await store.append({ role: "assistant", text: "hi", replyTo: user.sequence });

    const reopened = await TranscriptStore.open(path);
    expect(await reopened.history(10)).toEqual([
      expect.objectContaining({ sequence: 1, role: "user", text: "hello" }),
      expect.objectContaining({ sequence: 2, role: "assistant", text: "hi", replyTo: 1 }),
    ]);
    expect((await reopened.append({ role: "user", text: "again" })).sequence).toBe(3);
  });

  test("ignores and repairs a partially written final record", async () => {
    const { path, store } = await temporaryTranscript();
    await store.append({ role: "user", text: "complete" });
    await appendFile(path, '{"version":1,"sequence":2');

    const reopened = await TranscriptStore.open(path);
    expect((await reopened.history(10)).map((event) => event.text)).toEqual(["complete"]);
    await reopened.append({ role: "assistant", text: "recovered", replyTo: 1 });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).text).toBe("recovered");
  });

  test("enforces private file permissions", async () => {
    const { path, store } = await temporaryTranscript();
    await writeFile(path, "", { mode: 0o666 });
    await chmod(path, 0o666);
    const reopened = await TranscriptStore.open(path);
    await reopened.append({ role: "user", text: "private" });
    expect(await reopened.permissions()).toBe(0o600);
    expect(await store.permissions()).toBe(0o600);
  });

  test("publishes only newly appended events to followers", async () => {
    const { store } = await temporaryTranscript();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((event) => seen.push(event.text));
    await store.append({ role: "user", text: "observed" });
    unsubscribe();
    await store.append({ role: "assistant", text: "not observed", replyTo: 1 });
    expect(seen).toEqual(["observed"]);
  });
});
