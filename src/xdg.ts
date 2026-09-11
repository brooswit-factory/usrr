export interface XdgInputs {
  readonly home: string;
  readonly stateHome: string | undefined;
  readonly runtimeDir: string | undefined;
  readonly runtimeFallbackBase: string;
}

function configured(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

function join(...parts: string[]): string {
  return parts
    .map((part, index) => index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/");
}

export function stateFilePath(inputs: XdgInputs): string {
  return join(configured(inputs.stateHome, join(inputs.home, ".local", "state")), "usrr", "state.json");
}

export function transcriptFilePath(inputs: XdgInputs): string {
  return join(configured(inputs.stateHome, join(inputs.home, ".local", "state")), "usrr", "transcript.jsonl");
}

export function apiSocketPath(inputs: XdgInputs): string {
  return join(configured(inputs.runtimeDir, inputs.runtimeFallbackBase), "usrr", "api.sock");
}
