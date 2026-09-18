import { conversationRunner } from "./conversation";
import { startApiServer } from "./api/server";
import { startMcpAndInbox } from "./inbox";
import { log } from "./log";
import { agentCwd, mcpConfigPath, socketPath, statePath, transcriptPath } from "./paths";
import { UsrrService } from "./service";
import { loadState, recoverState, saveState } from "./state";
import { TranscriptStore } from "./transcript";

async function main(): Promise<void> {
  const resolvedStatePath = statePath();
  const resolvedSocketPath = socketPath();
  const recovered = recoverState(await loadState(resolvedStatePath));
  await saveState(resolvedStatePath, recovered);
  const transcript = await TranscriptStore.open(transcriptPath());
  const cwd = agentCwd();
  const service = new UsrrService(recovered, resolvedStatePath, provider => conversationRunner(provider, cwd), transcript, undefined, undefined, cwd);
  const started = await startApiServer(service, resolvedSocketPath);
  if (!started.ok) throw new Error(started.error);
  log("info", `USRR daemon started: state="${resolvedStatePath}" socket="${resolvedSocketPath}" agent=${recovered.provider ?? (recovered.conversationId ? "agy" : "unselected")}`);
  // usrrDeliver posts to this same socket, so the relay starts only once the API server is listening.
  const inbox = await startMcpAndInbox({ configPath: mcpConfigPath(), agentCwd: cwd, socketPath: resolvedSocketPath });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    await inbox.stop();
    started.handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((cause) => {
  log("error", `USRR daemon exiting: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
  process.exit(1);
});
