import { homedir } from "node:os";
import {
  InboxRelay,
  applyMcpAccess,
  keepChannelSource,
  mcpServersFromMcpJson,
  usrrDeliver,
  type ChannelSourceStatus,
  type DeliveryOutcome,
  type InboxMessage,
  type InboxRelayEvent,
  type KeepChannelSourceOptions,
  type McpServerDefinition,
} from "@brooswit/drovr";
import { log } from "./log";

/** How long shutdown waits for the channel source to close before giving up on it. */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function outcomeText(outcome: DeliveryOutcome): string {
  switch (outcome.status) {
    case "busy":
      return "busy — agy is mid-turn";
    case "failed":
      return `failed: ${outcome.detail}`;
    case "rejected":
      return `rejected: ${outcome.detail}`;
    default:
      return outcome.status;
  }
}

/**
 * Resolves true if `work` settles within `ms`, false if it does not. A rejection counts as
 * settled: the caller is shutting down and only needs to know whether to stop waiting.
 */
function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      cause => {
        clearTimeout(timer);
        log("warn", `rocketr channel close failed: ${errorMessage(cause)}`);
        resolve(true);
      },
    );
  });
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
  /** Injection for tests: first reconnect backoff, doubling per failure. Drovr's default is 1s. */
  backoffMs?: number;
  /** Injection for tests: how the reconnect loop waits, so a test need not spend real time. */
  wait?: KeepChannelSourceOptions["wait"];
  /** How long `stop()` waits for the channel to close before continuing. Default 5s. */
  stopTimeoutMs?: number;
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
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

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

  // A busy agy retries every few seconds for the whole length of a turn, so only the first
  // retry of each message is logged; the rest are counted and reported once it resolves.
  let retryingFor: InboxMessage | undefined;
  let retries = 0;

  const relay = new InboxRelay({
    deliver: usrrDeliver(socketPath),
    onEvent: (event: InboxRelayEvent) => {
      if (event.kind === "retrying") {
        if (event.message === retryingFor) {
          retries += 1;
          return;
        }
        retryingFor = event.message;
        retries = 1;
        log("info", `rocketr message delivery retrying (${outcomeText(event.outcome)}); further retries of this message are counted, not logged`);
        return;
      }

      let suffix = "";
      if (event.message === retryingFor) {
        suffix = ` after ${retries} ${retries === 1 ? "retry" : "retries"}`;
        retryingFor = undefined;
        retries = 0;
      }
      if (event.kind === "delivered") log("info", `rocketr message delivered to usrr${suffix}`);
      else log("error", `rocketr message DROPPED${suffix}: ${event.reason}`);
    },
  });

  const channel = keepChannelSource({
    name: "rocketr",
    url: rocketr.url,
    ...(rocketr.headers ? { headers: rocketr.headers } : {}),
    ...(deps.connect ? { connect: deps.connect } : {}),
    ...(deps.backoffMs !== undefined ? { backoffMs: deps.backoffMs } : {}),
    ...(deps.wait ? { wait: deps.wait } : {}),
    onMessage: message => relay.push(message),
    onStatus: (status: ChannelSourceStatus) => {
      if (status.kind === "connected") log("info", "rocketr channel connected");
      else if (status.kind === "disconnected") log("info", `rocketr channel disconnected: ${status.reason}`);
      else log("info", `rocketr channel reconnecting in ${status.inMs}ms`);
    },
  });

  return {
    async stop() {
      // A transport close that never settles must not hold the daemon open until systemd's
      // stop timeout: give it a bounded wait, then carry on and let the process exit.
      const closed = await settledWithin(channel.stop(), stopTimeoutMs);
      if (!closed) log("warn", `rocketr channel did not close within ${stopTimeoutMs}ms; continuing shutdown without it`);
      relay.stop();
    },
  };
}
