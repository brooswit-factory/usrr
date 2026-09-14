import { ManagedConversationLifecycle, NativeTranscriptUnavailableError, readNativeTranscript, processProviderAvailability, type ManagedAgentProvider, type ManagedConversationRunner, type ProviderAvailabilityRegistry } from "@brooswit/drovr";
import { providerOrder } from "./providers";
import { agentCwd } from "./paths";
import type { ApiError, AttachTargetResult, HistoryResult, MessageResult, PublicStatus, SwitchResult, WaitResult } from "./api/contract";
import { publicStatus, saveState, type PersistedState } from "./state";
import type { TranscriptEvent, TranscriptStore } from "./transcript";

const failure = (kind: ApiError["kind"], message: string): { ok: false; error: ApiError } => ({ ok: false, error: { kind, message } });

export type ConversationFactory = (provider: ManagedAgentProvider) => Pick<ManagedConversationRunner, "message">;

export class UsrrService {
  private active: Promise<void> | undefined;
  private readonly lifecycle: ManagedConversationLifecycle;

  constructor(
    private state: PersistedState,
    private readonly statePath: string,
    createRunner: ConversationFactory,
    private readonly transcript: TranscriptStore,
    providers: readonly ManagedAgentProvider[] = providerOrder(),
    availability: ProviderAvailabilityRegistry = processProviderAvailability,
    private readonly cwd: string = agentCwd(),
    private readonly nativeTranscriptReader: typeof readNativeTranscript = readNativeTranscript,
  ) {
    this.lifecycle = new ManagedConversationLifecycle({
      ...(state.conversationId ? { current: { provider: state.provider ?? "agy", conversationId: state.conversationId } } : {}),
      cwd, providers, availability, accountId: "usrr-personal", createRunner, readNativeTranscript: nativeTranscriptReader,
      readTranscript: async beforeSequence => JSON.stringify((await transcript.history()).filter(event =>
        (event.role === "user" || event.role === "assistant") && (beforeSequence === undefined || event.sequence < beforeSequence))),
      commit: async (identity, context) => {
        if (context.kind === "handoff") {
          await transcript.append({ role: "handoff",
            ...(context.beforeSequence === undefined ? {} : { replyTo: context.beforeSequence }),
            text: JSON.stringify({ reason: context.reason, previous: context.previous ?? null, next: identity }),
          });
        }
        await this.persist({ version: 1, ...identity, status: "working", updatedAt: new Date().toISOString() });
      },
    });
  }

  status(): PublicStatus { return publicStatus(this.state); }

  private async persist(next: PersistedState): Promise<void> {
    await saveState(this.statePath, next);
    this.state = next;
  }

  async switchProvider(provider: ManagedAgentProvider): Promise<SwitchResult> {
    if (this.active) return failure("busy", "USRR is already working");
    const operation = Promise.resolve().then(async () => {
      try {
        const { error: _error, ...previous } = this.state;
        await this.persist({ ...previous, status: "working", updatedAt: new Date().toISOString() });
        const reason = "Explicit USRR provider switch";
        const current = await this.lifecycle.switchProvider(provider, reason);
        await this.persist({ version: 1, ...current, status: "idle", updatedAt: new Date().toISOString() });
        return current;
      } catch (cause) {
        await this.persist({ ...this.state, status: "error", error: cause instanceof Error ? cause.message : String(cause), updatedAt: new Date().toISOString() });
        throw cause;
      } finally {
        this.active = undefined;
      }
    });
    this.active = operation.then(() => {}, () => {});
    try { return { ok: true, result: await operation }; }
    catch (cause) { return failure("agent-failed", cause instanceof Error ? cause.message : String(cause)); }
  }

  private startMessage(text: string): { accepted: Promise<void>; completed: Promise<{ response: string }> } {
    if (this.active) throw new Error("USRR is already working");
    const workingState: PersistedState = {
      version: 1,
      status: "working",
      updatedAt: new Date().toISOString(),
      ...(this.state.conversationId ? { conversationId: this.state.conversationId } : {}),
      ...(this.state.provider ? { provider: this.state.provider } : {}),
    };
    this.state = workingState;
    let response = "";
    let userEvent: TranscriptEvent | undefined;
    const accepted = (async () => {
      await saveState(this.statePath, workingState);
      userEvent = await this.transcript.append({ role: "user", text });
    })();
    const operation = (async () => {
      try {
        await accepted;
        const result = await this.lifecycle.message(text, { beforeSequence: userEvent!.sequence, reason: "USRR provider fallback" });
        response = result.response;
        await this.transcript.append({ role: "assistant", text: result.response, replyTo: userEvent!.sequence });
        await this.persist({ version: 1, ...this.lifecycle.current!, status: "idle", updatedAt: new Date().toISOString() });
      } catch (cause) {
        if (userEvent) {
          await this.transcript.append({
            role: "error",
            text: cause instanceof Error ? cause.message : String(cause),
            replyTo: userEvent.sequence,
          }).catch(() => {});
        }
        await this.persist({
          version: 1,
          status: "error",
          updatedAt: new Date().toISOString(),
          ...(this.state.conversationId ? { conversationId: this.state.conversationId } : {}),
          ...(this.state.provider ? { provider: this.state.provider } : {}),
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      } finally {
        this.active = undefined;
      }
    })();
    this.active = operation;
    return { accepted, completed: operation.then(() => ({ response })) };
  }

  async message(text: string, wait: boolean): Promise<MessageResult> {
    if (this.active) return failure("busy", "USRR is already working");
    const operation = this.startMessage(text);
    try {
      await operation.accepted;
    } catch (cause) {
      void operation.completed.catch(() => {});
      return failure("internal-error", cause instanceof Error ? cause.message : String(cause));
    }
    if (!wait) {
      void operation.completed.catch(() => {});
      return { ok: true, result: { accepted: true } };
    }
    try {
      const result = await operation.completed;
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

  async history(limit: number): Promise<HistoryResult> {
    const current = this.lifecycle.current;
    if (current) {
      try {
        const nativeTranscript = await this.nativeTranscriptReader({ provider: current.provider, session: { kind: "id", value: current.conversationId }, cwd: this.cwd });
        return { ok: true, result: { events: [], nativeTranscript } };
      } catch (cause) {
        if (!(cause instanceof NativeTranscriptUnavailableError)) throw cause;
      }
    }
    return { ok: true, result: { events: await this.transcript.history(limit) } };
  }

  follow(listener: (event: TranscriptEvent) => void): () => void {
    return this.transcript.subscribe(listener);
  }

  attachTarget(): AttachTargetResult {
    if (this.active) return failure("busy", "USRR is working; wait before attaching");
    if (!this.state.conversationId) return failure("absent", "USRR has no conversation yet; send its first message before attaching");
    return { ok: true, result: { conversationId: this.state.conversationId, provider: this.state.provider ?? "agy" } };
  }
}
