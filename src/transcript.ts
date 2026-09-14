import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type TranscriptRole = "user" | "assistant" | "error" | "handoff";

export interface TranscriptEvent {
  readonly version: 1;
  readonly sequence: number;
  readonly timestamp: string;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly replyTo?: number;
}

type NewTranscriptEvent = Omit<TranscriptEvent, "version" | "sequence" | "timestamp">;
type Listener = (event: TranscriptEvent) => void;

interface ParsedTranscript {
  readonly events: TranscriptEvent[];
  readonly completeBytes: number;
  readonly hasPartialTail: boolean;
}

function isTranscriptEvent(value: unknown): value is TranscriptEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<TranscriptEvent>;
  return event.version === 1
    && Number.isSafeInteger(event.sequence)
    && (event.sequence ?? 0) > 0
    && typeof event.timestamp === "string"
    && (event.role === "user" || event.role === "assistant" || event.role === "error" || event.role === "handoff")
    && typeof event.text === "string"
    && (event.replyTo === undefined || (Number.isSafeInteger(event.replyTo) && event.replyTo > 0));
}

function parseTranscript(contents: Buffer): ParsedTranscript {
  const finalNewline = contents.lastIndexOf(0x0a);
  const completeBytes = finalNewline < 0 ? 0 : finalNewline + 1;
  const complete = contents.subarray(0, completeBytes).toString("utf8");
  const events: TranscriptEvent[] = [];
  for (const line of complete.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error("transcript contains an invalid complete JSON record"); }
    if (!isTranscriptEvent(parsed)) throw new Error("transcript contains an unsupported complete record");
    const previous = events.at(-1);
    if (previous && parsed.sequence <= previous.sequence) throw new Error("transcript sequence is not strictly increasing");
    events.push(parsed);
  }
  return { events, completeBytes, hasPartialTail: completeBytes < contents.byteLength };
}

async function readContents(path: string): Promise<Buffer> {
  try { return await readFile(path); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw cause;
  }
}

export class TranscriptStore {
  private nextSequence: number;
  private completeBytes: number;
  private needsTailRepair: boolean;
  private appendQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  private constructor(private readonly path: string, parsed: ParsedTranscript) {
    this.nextSequence = (parsed.events.at(-1)?.sequence ?? 0) + 1;
    this.completeBytes = parsed.completeBytes;
    this.needsTailRepair = parsed.hasPartialTail;
  }

  static async open(path: string): Promise<TranscriptStore> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const contents = await readContents(path);
    if (contents.byteLength > 0) await chmod(path, 0o600);
    return new TranscriptStore(path, parseTranscript(contents));
  }

  async append(input: NewTranscriptEvent): Promise<TranscriptEvent> {
    let appended: TranscriptEvent | undefined;
    const write = this.appendQueue.then(async () => {
      const handle = await open(this.path, "a+", 0o600);
      try {
        await handle.chmod(0o600);
        if (this.needsTailRepair) {
          await handle.truncate(this.completeBytes);
          this.needsTailRepair = false;
        }
        appended = {
          version: 1,
          sequence: this.nextSequence,
          timestamp: new Date().toISOString(),
          ...input,
        };
        const line = `${JSON.stringify(appended)}\n`;
        await handle.appendFile(line, "utf8");
        await handle.sync();
        this.completeBytes += Buffer.byteLength(line);
        this.nextSequence += 1;
      } finally {
        await handle.close();
      }
      for (const listener of this.listeners) {
        try { listener(appended!); }
        catch { this.listeners.delete(listener); }
      }
    });
    this.appendQueue = write.catch(() => {});
    await write;
    return appended!;
  }

  async history(limit?: number): Promise<TranscriptEvent[]> {
    await this.appendQueue;
    const parsed = parseTranscript(await readContents(this.path));
    return limit === undefined ? parsed.events : parsed.events.slice(-limit);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async permissions(): Promise<number | undefined> {
    try { return (await stat(this.path)).mode & 0o777; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }
}
