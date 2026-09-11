import type { AgyRunner } from "./agy";
import type { ApiError, AttachTargetResult, MessageResult, PublicStatus, WaitResult } from "./api/contract";
import { publicStatus, saveState, type PersistedState } from "./state";

const failure = (kind: ApiError["kind"], message: string): { ok: false; error: ApiError } => ({ ok: false, error: { kind, message } });

export class UsrrService {
  private active: Promise<void> | undefined;

  constructor(private state: PersistedState, private readonly statePath: string, private readonly agent: AgyRunner) {}

  status(): PublicStatus { return publicStatus(this.state); }

  private async persist(next: PersistedState): Promise<void> {
    await saveState(this.statePath, next);
    this.state = next;
  }

  private startMessage(text: string): Promise<{ response: string }> {
    if (this.active) throw new Error("USRR is already working");
    const workingState: PersistedState = {
      version: 1,
      status: "working",
      updatedAt: new Date().toISOString(),
      ...(this.state.conversationId ? { conversationId: this.state.conversationId } : {}),
    };
    this.state = workingState;
    let response = "";
    const operation = (async () => {
      try {
        await saveState(this.statePath, workingState);
        const result = await this.agent.message(text, this.state.conversationId);
        response = result.response;
        await this.persist({ version: 1, conversationId: result.conversationId, status: "idle", updatedAt: new Date().toISOString() });
      } catch (cause) {
        await this.persist({
          version: 1,
          status: "error",
          updatedAt: new Date().toISOString(),
          ...(this.state.conversationId ? { conversationId: this.state.conversationId } : {}),
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      } finally {
        this.active = undefined;
      }
    })();
    this.active = operation;
    return operation.then(() => ({ response }));
  }

  async message(text: string, wait: boolean): Promise<MessageResult> {
    if (this.active) return failure("busy", "USRR is already working");
    const operation = this.startMessage(text);
    if (!wait) {
      void operation.catch(() => {});
      return { ok: true, result: { accepted: true } };
    }
    try {
      const result = await operation;
      return { ok: true, result: { accepted: true, response: result.response } };
    } catch (cause) {
      return failure("agent-failed", cause instanceof Error ? cause.message : String(cause));
    }
  }

  async waitUntilIdle(timeoutMs: number): Promise<WaitResult> {
    if (!this.active) return { ok: true, result: publicStatus(this.state) };
    if (timeoutMs === 0) return failure("busy", "USRR is still working");
    const settled = await Promise.race([
      this.active.then(() => "settled" as const).catch(() => "settled" as const),
      Bun.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (settled === "timeout") return failure("busy", "timed out waiting for USRR to become idle");
    return { ok: true, result: publicStatus(this.state) };
  }

  attachTarget(): AttachTargetResult {
    if (this.active) return failure("busy", "USRR is working; wait before attaching");
    if (!this.state.conversationId) return failure("absent", "USRR has no conversation yet; send its first message before attaching");
    return { ok: true, result: { conversationId: this.state.conversationId } };
  }
}
