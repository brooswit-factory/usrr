import type { ApiResult } from "../api/contract";
import type { ApiClient, CallResult } from "./api-client";
import { parseArgv } from "./grammar";
import type { TranscriptEvent } from "../transcript";
import type { ManagedAgentProvider } from "@brooswit/drovr";

export interface CliIO {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  writeOut(text: string): void;
  writeErr(text: string): void;
  attach(conversationId: string, provider?: ManagedAgentProvider): Promise<number>;
}

function unwrap<T>(call: CallResult<ApiResult<T>>, io: CliIO): { ok: true; result: T } | { ok: false; exitCode: number } {
  if (call.transport === "unreachable") { io.writeErr(`usrr: daemon unreachable: ${call.detail}\n`); return { ok: false, exitCode: 3 }; }
  if (call.transport === "protocol-error") { io.writeErr(`usrr: daemon response was invalid: ${call.detail}\n`); return { ok: false, exitCode: 3 }; }
  if (!call.body.ok) {
    io.writeErr(`usrr: ${call.body.error.message}\n`);
    return { ok: false, exitCode: call.body.error.kind === "internal-error" || call.body.error.kind === "agent-failed" ? 3 : 1 };
  }
  return { ok: true, result: call.body.result };
}

export function renderTranscriptEvent(event: TranscriptEvent): string {
  const reply = event.replyTo === undefined ? "" : ` reply-to=${event.replyTo}`;
  return `[${event.timestamp}] ${event.role.toUpperCase()} #${event.sequence}${reply}\n${event.text}\n`;
}

export async function runCli(argv: readonly string[], api: ApiClient, io: CliIO): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) { io.writeErr(`${parsed.error}\n`); return 2; }
  const command = parsed.command;
  if (command.kind === "status") {
    const result = unwrap(await api.status(), io); if (!result.ok) return result.exitCode;
    io.writeOut(command.json ? `${JSON.stringify(result.result, null, 2)}\n` : `${result.result.status}\n`); return 0;
  }
  if (command.kind === "message") {
    const result = unwrap(await api.message(command.text, command.wait), io); if (!result.ok) return result.exitCode;
    if (command.wait && result.result.response) io.writeOut(result.result.response); else io.writeOut("accepted\n"); return 0;
  }
  if (command.kind === "wait") {
    const result = unwrap(await api.wait(command.timeoutMs), io); if (!result.ok) return result.exitCode;
    io.writeOut(`${result.result.status}\n`); return 0;
  }
  if (command.kind === "history") {
    const result = unwrap(await api.history(command.limit), io); if (!result.ok) return result.exitCode;
    if (command.json) io.writeOut(`${JSON.stringify(result.result.events, null, 2)}\n`);
    else if (result.result.events.length === 0) io.writeOut("No transcript events.\n");
    else io.writeOut(result.result.events.map(renderTranscriptEvent).join("\n"));
    return 0;
  }
  if (command.kind === "follow") {
    const result = await api.follow((event) => io.writeOut(command.json ? `${JSON.stringify(event)}\n` : `${renderTranscriptEvent(event)}\n`));
    if (result.transport === "unreachable") { io.writeErr(`usrr: daemon unreachable: ${result.detail}\n`); return 3; }
    if (result.transport === "protocol-error") { io.writeErr(`usrr: daemon response was invalid: ${result.detail}\n`); return 3; }
    return 0;
  }
  if (!io.stdinIsTTY || !io.stdoutIsTTY) { io.writeErr("usrr: attach requires an interactive terminal\n"); return 1; }
  const result = unwrap(await api.attachTarget(), io); if (!result.ok) return result.exitCode;
  return await io.attach(result.result.conversationId, result.result.provider ?? "agy");
}
