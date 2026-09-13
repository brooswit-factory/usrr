import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentStatus, PublicStatus } from "./api/contract";
import type { ManagedAgentProvider } from "@brooswit/drovr";

export interface PersistedState {
  version: 1;
  conversationId?: string;
  provider?: ManagedAgentProvider;
  status: AgentStatus;
  updatedAt: string;
  error?: string;
}

export function emptyState(): PersistedState {
  return { version: 1, status: "absent", updatedAt: new Date(0).toISOString() };
}

export async function loadState(path: string): Promise<PersistedState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedState>;
    if (parsed.version !== 1 || typeof parsed.status !== "string" || typeof parsed.updatedAt !== "string") {
      throw new Error("unsupported state shape");
    }
    if (parsed.provider !== undefined && !["agy", "codex", "claude"].includes(parsed.provider)) throw new Error("unsupported conversation provider");
    return parsed as PersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new Error(`cannot read USRR state: ${(error as Error).message}`);
  }
}

export async function saveState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function recoverState(state: PersistedState, at = new Date()): PersistedState {
  if (state.status !== "working") return state;
  return {
    version: 1,
    status: state.conversationId ? "idle" : "absent",
    updatedAt: at.toISOString(),
    ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    ...(state.provider ? { provider: state.provider } : {}),
  };
}

export function publicStatus(state: PersistedState): PublicStatus {
  return {
    status: state.status,
    updatedAt: state.updatedAt,
    ...(state.conversationId ? { provider: state.provider ?? "agy" } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}
