import { describe, expect, test } from "bun:test";
import { apiSocketPath, stateFilePath, transcriptFilePath, type XdgInputs } from "../src/xdg";

const base: XdgInputs = { home: "/home/test", stateHome: undefined, runtimeDir: undefined, runtimeFallbackBase: "/tmp/usrr-1000" };

describe("XDG paths", () => {
  test("uses standard fallbacks", () => {
    expect(stateFilePath(base)).toBe("/home/test/.local/state/usrr/state.json");
    expect(transcriptFilePath(base)).toBe("/home/test/.local/state/usrr/transcript.jsonl");
    expect(apiSocketPath(base)).toBe("/tmp/usrr-1000/usrr/api.sock");
  });
  test("treats empty variables as unset", () => {
    expect(stateFilePath({ ...base, stateHome: "" })).toBe("/home/test/.local/state/usrr/state.json");
    expect(apiSocketPath({ ...base, runtimeDir: "" })).toBe("/tmp/usrr-1000/usrr/api.sock");
  });
  test("honors configured homes", () => {
    expect(stateFilePath({ ...base, stateHome: "/state" })).toBe("/state/usrr/state.json");
    expect(apiSocketPath({ ...base, runtimeDir: "/run/user/1000" })).toBe("/run/user/1000/usrr/api.sock");
  });
});
