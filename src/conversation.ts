import { ManagedConversationRunner, type ManagedAgentProvider, type RunProcess } from "@brooswit/drovr";
import { agentCwd } from "./paths";

/** USRR supplies user intent; Drovr owns all provider CLI and result handling. */
export function conversationRunner(provider: ManagedAgentProvider, cwd = agentCwd(), run?: RunProcess): ManagedConversationRunner {
  return new ManagedConversationRunner({
    provider,
    cwd,
    permissionMode: process.env["USRR_AGY_PERMISSION_MODE"] ?? "accept-edits",
    ...(run ? { run } : {}),
  });
}
