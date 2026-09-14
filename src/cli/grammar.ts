import type { ManagedAgentProvider } from "@brooswit/drovr";

export type ParsedCommand =
  | { kind: "switch"; provider: ManagedAgentProvider }
  | { kind: "attach" }
  | { kind: "status"; json: boolean }
  | { kind: "message"; text: string; wait: boolean }
  | { kind: "wait"; timeoutMs: number }
  | { kind: "history"; limit: number; json: boolean }
  | { kind: "follow"; json: boolean };
export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: string };

const HISTORY_DEFAULT_LIMIT = 20;

function parseHistory(argv: readonly string[]): ParseResult {
  const json = argv.includes("--json");
  const positional = argv.slice(1).filter((part) => part !== "--json");
  if (positional.length > 1 || argv.slice(1).some((part) => part.startsWith("--") && part !== "--json")) {
    return { ok: false, error: "usage: usrr history [limit] [--json]" };
  }
  const limit = positional[0] === undefined ? HISTORY_DEFAULT_LIMIT : Number(positional[0]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, error: "history limit must be an integer from 1 to 1000" };
  }
  return { ok: true, command: { kind: "history", limit, json } };
}

export function parseArgv(argv: readonly string[]): ParseResult {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "attach")) return { ok: true, command: { kind: "attach" } };
  if (argv[0] === "status") {
    if (argv.length === 1) return { ok: true, command: { kind: "status", json: false } };
    if (argv.length === 2 && argv[1] === "--json") return { ok: true, command: { kind: "status", json: true } };
    return { ok: false, error: "usage: usrr status [--json]" };
  }
  if (argv[0] === "message") {
    const wait = !argv.includes("--no-wait");
    const text = argv.slice(1).filter((part) => part !== "--no-wait").join(" ").trim();
    if (!text) return { ok: false, error: "usage: usrr message [--no-wait] <text>" };
    return { ok: true, command: { kind: "message", text, wait } };
  }
  if (argv[0] === "switch") {
    const provider = argv[1];
    if (argv.length !== 2 || (provider !== "agy" && provider !== "codex" && provider !== "claude")) return { ok: false, error: "usage: usrr switch <agy|codex|claude>" };
    return { ok: true, command: { kind: "switch", provider } };
  }
  if (argv[0] === "wait") {
    if (argv.length > 2) return { ok: false, error: "usage: usrr wait [seconds]" };
    const seconds = argv[1] === undefined ? 300 : Number(argv[1]);
    if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, error: "wait seconds must be a non-negative number" };
    return { ok: true, command: { kind: "wait", timeoutMs: seconds * 1000 } };
  }
  if (argv[0] === "history") return parseHistory(argv);
  if (argv[0] === "follow") {
    if (argv.length === 1) return { ok: true, command: { kind: "follow", json: false } };
    if (argv.length === 2 && argv[1] === "--json") return { ok: true, command: { kind: "follow", json: true } };
    return { ok: false, error: "usage: usrr follow [--json]" };
  }
  return { ok: false, error: "usage: usrr [attach] | status [--json] | message [--no-wait] <text> | switch <agy|codex|claude> | wait [seconds] | history [limit] [--json] | follow [--json]" };
}
