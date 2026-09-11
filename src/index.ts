import { AgyRunner } from "./agy";
import { startApiServer } from "./api/server";
import { log } from "./log";
import { agentCwd, socketPath, statePath } from "./paths";
import { UsrrService } from "./service";
import { loadState, recoverState, saveState } from "./state";

async function main(): Promise<void> {
  const resolvedStatePath = statePath();
  const resolvedSocketPath = socketPath();
  const recovered = recoverState(await loadState(resolvedStatePath));
  await saveState(resolvedStatePath, recovered);
  const service = new UsrrService(recovered, resolvedStatePath, new AgyRunner(agentCwd()));
  const started = await startApiServer(service, resolvedSocketPath);
  if (!started.ok) throw new Error(started.error);
  log("info", `USRR daemon started: state="${resolvedStatePath}" socket="${resolvedSocketPath}" agent=agy`);
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    started.handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((cause) => {
  log("error", `USRR daemon exiting: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
  process.exit(1);
});
