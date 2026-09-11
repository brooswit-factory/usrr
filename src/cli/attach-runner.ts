import { AgyRunner } from "../agy";
import { agentCwd } from "../paths";

export async function attach(conversationId: string): Promise<number> {
  const argv = new AgyRunner(agentCwd()).attachArgv(conversationId);
  const process = Bun.spawn(argv, { cwd: agentCwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await process.exited;
}
