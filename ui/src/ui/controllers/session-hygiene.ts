import type { GatewayHelloOk } from "../gateway.ts";
import type { GatewayBrowserClient } from "../gateway.ts";

export const SESSION_HYGIENE_METHOD = "sessions.hygiene";
export const SESSION_HYGIENE_EVENT = "session.hygiene";

export type SessionHygieneMode = "clean" | "compacted-continuation";
export type SessionHygienePhase =
  | "starting"
  | "resolving-transcript"
  | "preparing-working-copy"
  | "compacting"
  | "writing-cleaned-session"
  | "creating-continuation"
  | "seeding-continuation"
  | "completed"
  | "failed";

export type SessionHygieneOption = {
  mode: SessionHygieneMode;
  title: string;
  description: string;
  actionLabel: string;
  busyLabel: string;
  successLabel: string;
  createsContinuation: boolean;
};

export const SESSION_HYGIENE_OPTIONS: readonly SessionHygieneOption[] = [
  {
    mode: "clean",
    title: "Clean current session",
    description: "Trim and repair the active session in place before the next turn.",
    actionLabel: "Clean session",
    busyLabel: "Cleaning…",
    successLabel: "Current session cleaned.",
    createsContinuation: false,
  },
  {
    mode: "compacted-continuation",
    title: "Create compacted continuation",
    description: "Create a fresh continuation seeded from a compacted summary of this session.",
    actionLabel: "Create continuation",
    busyLabel: "Creating continuation…",
    successLabel: "Compacted continuation created.",
    createsContinuation: true,
  },
] as const;

export type SessionHygieneRequest = {
  sessionKey: string;
  mode: SessionHygieneMode;
};

export type SessionHygieneResult = {
  mode: SessionHygieneMode;
  sessionKey: string;
  continuationSessionKey: string | null;
  message: string | null;
  summary: string;
  detail: string | null;
  completedAt: number;
};

export type SessionHygieneProgress = {
  mode: SessionHygieneMode;
  sessionKey: string;
  phase: SessionHygienePhase;
  status: "running" | "completed" | "failed";
  summary: string;
  detail: string | null;
  step: number | null;
  totalSteps: number | null;
  compacted: boolean | null;
  continuationSessionKey: string | null;
  updatedAt: number;
};

export type SessionHygieneState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  hello: GatewayHelloOk | null;
  sessionHygieneBusy: boolean;
  sessionHygieneMode: SessionHygieneMode;
  sessionHygieneError: string | null;
  sessionHygieneProgress: SessionHygieneProgress | null;
  sessionHygieneResult: SessionHygieneResult | null;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeSessionHygieneResponse(
  request: SessionHygieneRequest,
  raw: unknown,
): SessionHygieneResult {
  const option = getSessionHygieneOption(request.mode);
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const continuation =
    payload.continuation && typeof payload.continuation === "object"
      ? (payload.continuation as Record<string, unknown>)
      : {};
  const continuationSessionKey =
    readString(payload.continuationSessionKey) ??
    readString(payload.nextSessionKey) ??
    readString(continuation.sessionKey);
  const message =
    readString(payload.message) ??
    readString(payload.summary) ??
    readString(continuation.message) ??
    null;
  return {
    mode: request.mode,
    sessionKey: readString(payload.sessionKey) ?? request.sessionKey,
    continuationSessionKey,
    message,
    summary:
      message ??
      (continuationSessionKey && option.createsContinuation
        ? `Continuation ready: ${continuationSessionKey}`
        : option.successLabel),
    detail: readString(payload.detail),
    completedAt: Date.now(),
  };
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isSessionHygienePhase(value: unknown): value is SessionHygienePhase {
  return (
    value === "starting" ||
    value === "resolving-transcript" ||
    value === "preparing-working-copy" ||
    value === "compacting" ||
    value === "writing-cleaned-session" ||
    value === "creating-continuation" ||
    value === "seeding-continuation" ||
    value === "completed" ||
    value === "failed"
  );
}

function normalizeSessionHygieneProgress(
  payload: unknown,
  fallback: { mode: SessionHygieneMode; sessionKey: string },
): SessionHygieneProgress | null {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!data) {
    return null;
  }
  const rawPhase = data.phase;
  if (!isSessionHygienePhase(rawPhase)) {
    return null;
  }
  const summary = readString(data.summary) ?? readString(data.message);
  if (!summary) {
    return null;
  }
  const rawStatus = readString(data.status);
  const status =
    rawStatus === "completed" || rawStatus === "failed" ? rawStatus : ("running" as const);
  return {
    mode:
      readString(data.mode) === "compacted-continuation" ? "compacted-continuation" : fallback.mode,
    sessionKey: readString(data.sessionKey) ?? fallback.sessionKey,
    phase: rawPhase,
    status,
    summary,
    detail: readString(data.detail),
    step: readInteger(data.step),
    totalSteps: readInteger(data.totalSteps),
    compacted: readBoolean(data.compacted),
    continuationSessionKey: readString(data.continuationSessionKey),
    updatedAt: readInteger(data.updatedAt) ?? Date.now(),
  };
}

export function getSessionHygieneOption(mode: SessionHygieneMode): SessionHygieneOption {
  return (
    SESSION_HYGIENE_OPTIONS.find((option) => option.mode === mode) ?? SESSION_HYGIENE_OPTIONS[0]
  );
}

export function supportsSessionHygiene(hello: GatewayHelloOk | null): boolean {
  const methods = hello?.features?.methods;
  return Array.isArray(methods) && methods.includes(SESSION_HYGIENE_METHOD);
}

export function applySessionHygieneProgressEvent(
  state: SessionHygieneState,
  payload: unknown,
): SessionHygieneProgress | null {
  const progress = normalizeSessionHygieneProgress(payload, {
    mode: state.sessionHygieneMode,
    sessionKey: state.sessionKey,
  });
  if (!progress) {
    return null;
  }
  state.sessionHygieneProgress = progress;
  if (progress.status === "failed") {
    state.sessionHygieneBusy = false;
    state.sessionHygieneError = progress.detail ?? progress.summary;
  } else if (progress.status === "completed") {
    state.sessionHygieneBusy = false;
  }
  return progress;
}

export async function runSessionHygiene(
  state: SessionHygieneState,
  mode: SessionHygieneMode = state.sessionHygieneMode,
): Promise<SessionHygieneResult | null> {
  if (!state.client || !state.connected) {
    state.sessionHygieneError = "Reconnect the gateway before running session hygiene.";
    return null;
  }
  if (state.sessionHygieneBusy) {
    return null;
  }
  if (!supportsSessionHygiene(state.hello)) {
    state.sessionHygieneError = "This gateway does not advertise session hygiene support yet.";
    return null;
  }

  state.sessionHygieneBusy = true;
  state.sessionHygieneMode = mode;
  state.sessionHygieneError = null;
  state.sessionHygieneProgress = {
    mode,
    sessionKey: state.sessionKey,
    phase: "starting",
    status: "running",
    summary: "Starting session hygiene…",
    detail: null,
    step: 1,
    totalSteps: null,
    compacted: null,
    continuationSessionKey: null,
    updatedAt: Date.now(),
  };
  state.sessionHygieneResult = null;
  try {
    const request: SessionHygieneRequest = {
      sessionKey: state.sessionKey,
      mode,
    };
    const raw = await state.client.request(SESSION_HYGIENE_METHOD, request);
    const result = normalizeSessionHygieneResponse(request, raw);
    state.sessionHygieneResult = result;
    state.sessionHygieneProgress = {
      mode: result.mode,
      sessionKey: result.sessionKey,
      phase: "completed",
      status: "completed",
      summary: result.summary,
      detail: result.detail,
      step: null,
      totalSteps: null,
      compacted: null,
      continuationSessionKey: result.continuationSessionKey,
      updatedAt: result.completedAt,
    };
    return result;
  } catch (err) {
    state.sessionHygieneError = String(err);
    state.sessionHygieneProgress = {
      mode,
      sessionKey: state.sessionKey,
      phase: "failed",
      status: "failed",
      summary: "Session hygiene failed.",
      detail: String(err),
      step: null,
      totalSteps: null,
      compacted: null,
      continuationSessionKey: null,
      updatedAt: Date.now(),
    };
    return null;
  } finally {
    state.sessionHygieneBusy = false;
  }
}
