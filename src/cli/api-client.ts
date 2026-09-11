import * as http from "node:http";
import { API_ROUTES, type AttachTargetResult, type MessageResult, type StatusResult, type WaitResult } from "../api/contract";

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
    message: (text: string, wait: boolean) => call<MessageResult>(socketPath, API_ROUTES.message.method, API_ROUTES.message.path, { text, wait }, wait ? 10 * 60_000 : 10_000),
    wait: (timeoutMs: number) => call<WaitResult>(socketPath, API_ROUTES.wait.method, API_ROUTES.wait.path, { timeoutMs }, timeoutMs + 10_000),
    attachTarget: () => call<AttachTargetResult>(socketPath, API_ROUTES.attachTarget.method, API_ROUTES.attachTarget.path, undefined),
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
