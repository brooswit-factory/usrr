import type { TranscriptEvent } from "../transcript";
import type { ManagedAgentProvider } from "@brooswit/drovr";

export type AgentStatus = "absent" | "idle" | "working" | "error";
export interface PublicStatus { readonly status: AgentStatus; readonly updatedAt: string; readonly error?: string; readonly provider?: ManagedAgentProvider }
export type ApiErrorKind = "absent" | "busy" | "invalid-request" | "agent-failed" | "internal-error";
export interface ApiError { readonly kind: ApiErrorKind; readonly message: string }
export type ApiResult<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: ApiError };
export type StatusResult = ApiResult<PublicStatus>;
export type MessageResult = ApiResult<{ readonly accepted: true; readonly response?: string }>;
export type WaitResult = ApiResult<PublicStatus>;
export type SwitchResult = ApiResult<{ readonly provider: ManagedAgentProvider; readonly conversationId: string }>;
export type AttachTargetResult = ApiResult<{ readonly conversationId: string; readonly provider?: ManagedAgentProvider }>;
export type HistoryResult = ApiResult<{ readonly events: readonly TranscriptEvent[]; readonly nativeTranscript?: string }>;

export const API_ROUTES = {
  status: { method: "GET", path: "/v1/status" },
  message: { method: "POST", path: "/v1/message" },
  switch: { method: "POST", path: "/v1/switch" },
  wait: { method: "POST", path: "/v1/wait" },
  attachTarget: { method: "GET", path: "/v1/attach-target" },
  history: { method: "GET", path: "/v1/history" },
  follow: { method: "GET", path: "/v1/follow" },
} as const;

export const STATUS_FOR_ERROR: Record<ApiErrorKind, number> = {
  absent: 404,
  busy: 409,
  "invalid-request": 400,
  "agent-failed": 502,
  "internal-error": 500,
};
