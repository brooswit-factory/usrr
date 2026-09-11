export type ParsedCommand = { kind: "attach" } | { kind: "status"; json: boolean } | { kind: "message"; text: string; wait: boolean } | { kind: "wait"; timeoutMs: number };
export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: string };

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
  if (argv[0] === "wait") {
    if (argv.length > 2) return { ok: false, error: "usage: usrr wait [seconds]" };
    const seconds = argv[1] === undefined ? 300 : Number(argv[1]);
    if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, error: "wait seconds must be a non-negative number" };
    return { ok: true, command: { kind: "wait", timeoutMs: seconds * 1000 } };
  }
  return { ok: false, error: "usage: usrr [attach] | status [--json] | message [--no-wait] <text> | wait [seconds]" };
}
