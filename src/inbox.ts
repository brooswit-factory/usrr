import { homedir } from "node:os";
import {
  InboxRelay,
  applyMcpAccess,
  keepChannelSource,
  mcpServersFromMcpJson,
  usrrDeliver,
  type ChannelSourceStatus,
  type InboxRelayEvent,
  type KeepChannelSourceOptions,
  type McpServerDefinition,
} from "@brooswit/drovr";
import { log } from "./log";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface StartMcpAndInboxDeps {
  /** Resolved path to usrr's `.mcp.json`; see `mcpConfigPath()` in `./paths`. */
  configPath: string;
  /** The workspace agy's servers are provisioned into. */
  agentCwd: string;
  /** agy's own home, for its home-level settings files. Defaults to this process's home. */
  home?: string;
  /** usrr's own API socket; rocketr messages are delivered here as turns. */
  socketPath: string;
  /** Injection for tests: reads `.mcp.json`. Defaults to reading `configPath` from disk. */
  readConfig?: (path: string) => Promise<string>;
  /** Injection for tests: replaces the real rocketr connection. */
  connect?: KeepChannelSourceOptions["connect"];
}

export interface InboxHandle {
  stop(): Promise<void>;
}

const NO_OP: InboxHandle = { stop: async () => {} };

async function defaultReadConfig(path: string): Promise<string> {
  return await Bun.file(path).text();
}

export async function startMcpAndInbox(deps: StartMcpAndInboxDeps): Promise<InboxHandle> {
  const { configPath, agentCwd, socketPath } = deps;
  const home = deps.home ?? homedir();
  const readConfig = deps.readConfig ?? defaultReadConfig;

  let raw: string;
  try {
    raw = await readConfig(configPath);
  } catch (cause) {
    log("info", `no MCP config at "${configPath}" (${errorMessage(cause)}); starting without agy MCP provisioning or a rocketr relay`);
    return NO_OP;
  }

  let servers: Record<string, McpServerDefinition>;
  try {
    servers = mcpServersFromMcpJson(JSON.parse(raw));
  } catch (cause) {
    log("error", `MCP config "${configPath}" is unusable: ${errorMessage(cause)}; starting without agy MCP provisioning or a rocketr relay`);
    return NO_OP;
  }

  const entries = Object.entries(servers);
  if (entries.length === 0) {
    log("info", `MCP config "${configPath}" names no servers; skipping agy provisioning`);
  } else {
    try {
      const applied = await applyMcpAccess("agy", {
        cwd: agentCwd,
        home,
        servers: entries.map(([name, definition]) => ({ name, definition })),
      });
      log("info", `agy MCP access updated: changed=${applied.changed} restart=${applied.restart} written=[${applied.written.join(", ")}]; a running agy picks this up on its next turn, not this one`);
    } catch (cause) {
      log("error", `failed to provision agy MCP access: ${errorMessage(cause)}; agy will not see these servers until this is fixed`);
    }
  }

  const rocketr = servers["rocketr"];
  if (!rocketr) {
    log("info", `MCP config "${configPath}" names no rocketr server; running without a rocketr inbox relay`);
    return NO_OP;
  }
  if (rocketr.type !== "http") {
    log("error", `rocketr's MCP definition is "${rocketr.type}", not http; running without a rocketr inbox relay`);
    return NO_OP;
  }

  const relay = new InboxRelay({
    deliver: usrrDeliver(socketPath),
    onEvent: (event: InboxRelayEvent) => {
      if (event.kind === "delivered") log("info", `rocketr message delivered to usrr`);
      else if (event.kind === "retrying") log("info", `rocketr message delivery retrying: ${JSON.stringify(event.outcome)}`);
      else log("error", `rocketr message DROPPED: ${event.reason}`);
    },
  });

  const channel = keepChannelSource({
    name: "rocketr",
    url: rocketr.url,
    ...(rocketr.headers ? { headers: rocketr.headers } : {}),
    ...(deps.connect ? { connect: deps.connect } : {}),
    onMessage: message => relay.push(message),
    onStatus: (status: ChannelSourceStatus) => {
      if (status.kind === "connected") log("info", "rocketr channel connected");
      else if (status.kind === "disconnected") log("info", `rocketr channel disconnected: ${status.reason}`);
      else log("info", `rocketr channel reconnecting in ${status.inMs}ms`);
    },
  });

  return {
    async stop() {
      await channel.stop();
      relay.stop();
    },
  };
}
