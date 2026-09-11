import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/cli/grammar";

describe("CLI grammar", () => {
  test("bare usrr attaches", () => expect(parseArgv([])).toEqual({ ok: true, command: { kind: "attach" } }));
  test("parses message modes", () => {
    expect(parseArgv(["message", "hello", "there"])).toEqual({ ok: true, command: { kind: "message", text: "hello there", wait: true } });
    expect(parseArgv(["message", "--no-wait", "hello"])).toEqual({ ok: true, command: { kind: "message", text: "hello", wait: false } });
  });
  test("rejects invalid waits", () => expect(parseArgv(["wait", "later"]).ok).toBe(false));
});
