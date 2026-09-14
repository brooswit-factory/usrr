import * as http from "node:http";
import { API_ROUTES, type AttachTargetResult, type HistoryResult, type MessageResult, type StatusResult, type SwitchResult, type WaitResult } from "../api/contract";
import type { ManagedAgentProvider } from "@brooswit/drovr";
import type { TranscriptEvent } from "../transcript";

export type CallResult<T> = { transport: "ok"; status: number; body: T } | { transport: "unreachable"; detail: string } | { transport: "protocol-error"; detail: string };

function call<T>(socketPath: string, method: string, path: string, body: unknown | undefined, timeoutMs = 10_000): Promise<CallResult<T>> {
  return new Promise((resolve) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      socketPath, method, path, timeout: timeoutMs,
      headers: text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { data += chunk; });
      response.on("end", () => {
        try { resolve({ transport: "ok", status: response.statusCode ?? 0, body: JSON.parse(data) as T }); }
        catch (cause) { resolve({ transport: "protocol-error", detail: cause instanceof Error ? cause.message : String(cause) }); }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    request.on("error", (cause: Error) => resolve({ transport: "unreachable", detail: cause.message }));
    if (text !== undefined) request.write(text);
    request.end();
  });
}

export function createApiClient(socketPath: string) {
  return {
    status: () => call<StatusResult>(socketPath, API_ROUTES.status.method, API_ROUTES.status.path, undefined),
    switchProvider: (provider: ManagedAgentProvider) => call<SwitchResult>(socketPath, API_ROUTES.switch.method, API_ROUTES.switch.path, { provider }, 10 * 60_000),
    message: (text: string, wait: boolean) => call<MessageResult>(socketPath, API_ROUTES.message.method, API_ROUTES.message.path, { text, wait }, wait ? 10 * 60_000 : 10_000),
    wait: (timeoutMs: number) => call<WaitResult>(socketPath, API_ROUTES.wait.method, API_ROUTES.wait.path, { timeoutMs }, timeoutMs + 10_000),
    attachTarget: () => call<AttachTargetResult>(socketPath, API_ROUTES.attachTarget.method, API_ROUTES.attachTarget.path, undefined),
    history: (limit: number) => call<HistoryResult>(socketPath, API_ROUTES.history.method, `${API_ROUTES.history.path}?limit=${limit}`, undefined),
    follow: (onEvent: (event: TranscriptEvent) => void): Promise<CallResult<void>> => new Promise((resolve) => {
      let settled = false;
      let pending = "";
      const settle = (result: CallResult<void>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = http.request({ socketPath, method: API_ROUTES.follow.method, path: API_ROUTES.follow.path }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          settle({ transport: "protocol-error", detail: `follow returned HTTP ${response.statusCode ?? 0}` });
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          try {
            for (const line of lines) if (line.length > 0) onEvent(JSON.parse(line) as TranscriptEvent);
          } catch (cause) {
            request.destroy();
            settle({ transport: "protocol-error", detail: cause instanceof Error ? cause.message : String(cause) });
          }
        });
        response.on("end", () => {
          if (pending.length > 0) settle({ transport: "protocol-error", detail: "follow ended with an incomplete event" });
          else settle({ transport: "ok", status: response.statusCode ?? 200, body: undefined });
        });
      });
      request.on("error", (cause: Error) => settle({ transport: "unreachable", detail: cause.message }));
      request.end();
    }),
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
