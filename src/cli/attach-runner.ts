import { prepareManagedAgentWorkspace, type ManagedAgentProvider } from "@brooswit/drovr";
import { conversationRunner } from "../conversation";
import { agentCwd } from "../paths";

export async function attach(conversationId: string, provider: ManagedAgentProvider = "agy"): Promise<number> {
  const cwd = agentCwd();
  await prepareManagedAgentWorkspace({ provider, cwd, unattended: true, allowHomeWorkspace: true });
  const argv = conversationRunner(provider, cwd).attachArgv(conversationId);
  const process = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await process.exited;
}
