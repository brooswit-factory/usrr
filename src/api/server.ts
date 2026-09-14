import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { API_ROUTES, STATUS_FOR_ERROR, type ApiResult } from "./contract";
import type { UsrrService } from "../service";
import { log } from "../log";

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function isSocketLive(path: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: path, socket: { open() {}, data() {}, close() {}, error() {} } });
    socket.end();
    return true;
  } catch { return false; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function apiResponse<T>(result: ApiResult<T>): Response { return json(result, result.ok ? 200 : STATUS_FOR_ERROR[result.error.kind]); }
function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
async function bodyObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await request.text()) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export interface ApiServerHandle { readonly socketPath: string; stop(): void }
export type StartApiServerResult = { ok: true; handle: ApiServerHandle } | { ok: false; error: string };

export async function startApiServer(service: UsrrService, socketPath: string): Promise<StartApiServerResult> {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
  if (await exists(socketPath)) {
    if (await isSocketLive(socketPath)) return { ok: false, error: `refusing to start: another USRR daemon is already listening on "${socketPath}"` };
    await unlink(socketPath).catch(() => {});
  }
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === API_ROUTES.status.method && url.pathname === API_ROUTES.status.path) return apiResponse({ ok: true, result: service.status() });
        if (request.method === API_ROUTES.attachTarget.method && url.pathname === API_ROUTES.attachTarget.path) return apiResponse(service.attachTarget());
        if (request.method === API_ROUTES.history.method && url.pathname === API_ROUTES.history.path) {
          const limit = positiveInteger(url.searchParams.get("limit"));
          if (limit === undefined || limit > 1000) {
            return apiResponse({ ok: false, error: { kind: "invalid-request", message: "history limit must be an integer from 1 to 1000" } });
          }
          return apiResponse(await service.history(limit));
        }
        if (request.method === API_ROUTES.follow.method && url.pathname === API_ROUTES.follow.path) {
          let unsubscribe: (() => void) | undefined;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              unsubscribe = service.follow((event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)));
              heartbeat = setInterval(() => {
                try { controller.enqueue(encoder.encode("\n")); }
                catch {
                  if (heartbeat) clearInterval(heartbeat);
                  unsubscribe?.();
                }
              }, 5_000);
            },
            cancel() {
              if (heartbeat) clearInterval(heartbeat);
              unsubscribe?.();
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "application/x-ndjson",
              "cache-control": "no-store",
            },
          });
        }
        if (request.method === API_ROUTES.message.method && url.pathname === API_ROUTES.message.path) {
          const body = await bodyObject(request);
          if (!body || typeof body.text !== "string" || body.text.trim().length === 0 || (body.wait !== undefined && typeof body.wait !== "boolean")) {
            return apiResponse({ ok: false, error: { kind: "invalid-request", message: "message requires non-empty text and an optional boolean wait" } });
          }
          return apiResponse(await service.message(body.text, body.wait !== false));
        }
        if (request.method === API_ROUTES.switch.method && url.pathname === API_ROUTES.switch.path) {
          const body = await bodyObject(request);
          if (!body || (body.provider !== "agy" && body.provider !== "codex" && body.provider !== "claude")) {
            return apiResponse({ ok: false, error: { kind: "invalid-request", message: "switch requires provider agy, codex, or claude" } });
          }
          return apiResponse(await service.switchProvider(body.provider));
        }
        if (request.method === API_ROUTES.wait.method && url.pathname === API_ROUTES.wait.path) {
          const body = await bodyObject(request);
          if (!body || typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || body.timeoutMs < 0) {
            return apiResponse({ ok: false, error: { kind: "invalid-request", message: "wait requires a non-negative timeoutMs" } });
          }
          return apiResponse(await service.waitUntilIdle(body.timeoutMs));
        }
        return json({ ok: false, error: { kind: "invalid-request", message: "unknown USRR route" } }, 404);
      } catch (cause) {
        log("error", `request failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
        return apiResponse({ ok: false, error: { kind: "internal-error", message: "an unexpected daemon error occurred; see the USRR log" } });
      }
    },
    error(cause) {
      log("error", `Bun server error: ${cause.stack ?? cause.message}`);
      return apiResponse({ ok: false, error: { kind: "internal-error", message: "an unexpected daemon error occurred; see the USRR log" } });
    },
  });
  await chmod(socketPath, 0o600);
  return { ok: true, handle: { socketPath, stop() { server.stop(); try { unlinkSync(socketPath); } catch {} } } };
}
