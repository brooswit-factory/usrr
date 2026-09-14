import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/cli/grammar";

describe("CLI grammar", () => {
  test("parses only supported explicit provider switches", () => {
    for (const provider of ["agy", "codex", "claude"] as const) expect(parseArgv(["switch", provider])).toEqual({ ok: true, command: { kind: "switch", provider } });
    for (const args of [["switch"], ["switch", "other"], ["switch", "codex", "extra"]]) expect(parseArgv(args).ok).toBe(false);
  });
  test("bare usrr attaches", () => expect(parseArgv([])).toEqual({ ok: true, command: { kind: "attach" } }));
  test("parses message modes", () => {
    expect(parseArgv(["message", "hello", "there"])).toEqual({ ok: true, command: { kind: "message", text: "hello there", wait: true } });
    expect(parseArgv(["message", "--no-wait", "hello"])).toEqual({ ok: true, command: { kind: "message", text: "hello", wait: false } });
  });
  test("rejects invalid waits", () => expect(parseArgv(["wait", "later"]).ok).toBe(false));
  test("parses history limits and JSON output", () => {
    expect(parseArgv(["history"])).toEqual({ ok: true, command: { kind: "history", limit: 20, json: false } });
    expect(parseArgv(["history", "5", "--json"])).toEqual({ ok: true, command: { kind: "history", limit: 5, json: true } });
    expect(parseArgv(["history", "0"]).ok).toBe(false);
  });
  test("parses follow output modes", () => {
    expect(parseArgv(["follow"])).toEqual({ ok: true, command: { kind: "follow", json: false } });
    expect(parseArgv(["follow", "--json"])).toEqual({ ok: true, command: { kind: "follow", json: true } });
  });
});
