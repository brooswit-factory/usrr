export interface AgyResult {
  conversationId: string;
  response: string;
}

export type RunProcess = (argv: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const runProcess: RunProcess = async (argv, cwd) => {
  const process = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

interface AgyJson {
  conversation_id?: unknown;
  status?: unknown;
  response?: unknown;
}

export class AgyRunner {
  constructor(
    private readonly cwd: string,
    private readonly run: RunProcess = runProcess,
    private readonly permissionMode = process.env["USRR_AGY_PERMISSION_MODE"] ?? "accept-edits",
  ) {}

  private permissionArgs(): string[] {
    if (this.permissionMode === "yolo") return ["--dangerously-skip-permissions"];
    if (this.permissionMode === "plan") return ["--mode", "plan"];
    return ["--mode", "accept-edits"];
  }

  async message(text: string, conversationId?: string): Promise<AgyResult> {
    const argv = ["agy", ...this.permissionArgs(), "--output-format", "json"];
    if (conversationId) argv.push("--conversation", conversationId);
    argv.push("--print", text);
    const result = await this.run(argv, this.cwd);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Antigravity failed: ${detail}`);
    }
    let parsed: AgyJson;
    try {
      parsed = JSON.parse(result.stdout) as AgyJson;
    } catch {
      throw new Error("Antigravity returned invalid JSON");
    }
    if (parsed.status !== "SUCCESS" || typeof parsed.conversation_id !== "string" || typeof parsed.response !== "string") {
      throw new Error("Antigravity returned an unsuccessful or incomplete result");
    }
    return { conversationId: parsed.conversation_id, response: parsed.response };
  }

  attachArgv(conversationId: string): string[] {
    return ["agy", ...this.permissionArgs(), "--conversation", conversationId];
  }
}
