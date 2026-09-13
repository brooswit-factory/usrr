import { processProviderAvailability, runWithProviderFallback, type ManagedAgentProvider, type ManagedConversationRunner, type ProviderAvailabilityRegistry } from "@brooswit/drovr";
import { providerOrder } from "./providers";
import { conversationHandoff, HANDOFF_EVENT_LIMIT } from "./handoff";
import { agentCwd } from "./paths";
import type { ApiError, AttachTargetResult, HistoryResult, MessageResult, PublicStatus, WaitResult } from "./api/contract";
import { publicStatus, saveState, type PersistedState } from "./state";
import type { TranscriptEvent, TranscriptStore } from "./transcript";

const failure = (kind: ApiError["kind"], message: string): { ok: false; error: ApiError } => ({ ok: false, error: { kind, message } });

export type ConversationFactory = (provider: ManagedAgentProvider) => Pick<ManagedConversationRunner, "message">;

export class UsrrService {
  private active: Promise<void> | undefined;

  constructor(
    private state: PersistedState,
    private readonly statePath: string,
    private readonly createRunner: ConversationFactory,
    private readonly transcript: TranscriptStore,
    private readonly providers: readonly ManagedAgentProvider[] = providerOrder(),
    private readonly availability: ProviderAvailabilityRegistry = processProviderAvailability,
    private readonly cwd: string = agentCwd(),
  ) {}

  status(): PublicStatus { return publicStatus(this.state); }

  private async persist(next: PersistedState): Promise<void> {
    await saveState(this.statePath, next);
    this.state = next;
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
        const nativeProvider = this.state.conversationId ? this.state.provider ?? "agy" : undefined;
        const priority = nativeProvider ? [nativeProvider, ...this.providers] : this.providers;
        const outcome = await runWithProviderFallback({
          priority: priority.map(provider => ({ provider, accountId: "usrr-personal" })),
          availability: this.availability,
          attempt: async ({ provider }) => {
            const resume = provider === nativeProvider ? this.state.conversationId : undefined;
            let prompt = text;
            if (nativeProvider && provider !== nativeProvider) {
              const history = (await this.transcript.history(HANDOFF_EVENT_LIMIT + 1)).filter(event => event.sequence < userEvent!.sequence);
              prompt = conversationHandoff({ from: nativeProvider, to: provider, cwd: this.cwd, history, message: text });
              await this.transcript.append({ role: "handoff", replyTo: userEvent!.sequence,
                text: `Attempting a fresh ${provider} conversation from ${nativeProvider}; prior conversation ${this.state.conversationId} remains current until success.\n${prompt}` });
            }
            const value = await this.createRunner(provider).message(prompt, resume);
            return { status: "success" as const, value };
          },
        });
        if (outcome.status === "exhausted") throw new Error("USRR providers exhausted; current conversation retained");
        const provider = outcome.account.provider;
        const result = outcome.value;
        response = result.response;
        // Keep the returned native ID even if appending the response fails.
        await this.persist({ version: 1, provider, conversationId: result.conversationId, status: "working", updatedAt: new Date().toISOString() });
        await this.transcript.append({ role: "assistant", text: result.response, replyTo: userEvent!.sequence });
        await this.persist({ version: 1, provider, conversationId: result.conversationId, status: "idle", updatedAt: new Date().toISOString() });
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
