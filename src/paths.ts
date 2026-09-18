import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import * as xdg from "./xdg";

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** The usrr repo's own root, regardless of the daemon's working directory. */
const repoRoot = (): string => dirname(import.meta.dir);

export function currentXdgInputs(): xdg.XdgInputs {
  return {
    home: homedir(),
    stateHome: nonEmpty(process.env["XDG_STATE_HOME"]),
    runtimeDir: nonEmpty(process.env["XDG_RUNTIME_DIR"]),
    runtimeFallbackBase: `${tmpdir()}/usrr-${process.getuid?.() ?? "nouid"}`,
  };
}

export const statePath = (): string => xdg.stateFilePath(currentXdgInputs());
export const transcriptPath = (): string => xdg.transcriptFilePath(currentXdgInputs());
export const socketPath = (): string => xdg.apiSocketPath(currentXdgInputs());
export const agentCwd = (): string => nonEmpty(process.env["USRR_AGENT_CWD"]) ?? homedir();
export const mcpConfigPath = (): string => nonEmpty(process.env["USRR_MCP_CONFIG"]) ?? `${repoRoot()}/.mcp.json`;
