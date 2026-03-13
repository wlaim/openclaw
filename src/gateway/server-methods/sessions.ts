import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { resolveContextWindowInfo } from "../../agents/context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { compactEmbeddedPiSessionDirect } from "../../agents/pi-embedded-runner/compact.runtime.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { closeTrackedBrowserTabsForSessions } from "../../browser/session-tab-registry.js";
import { loadConfig } from "../../config/config.js";
import {
  appendAssistantMessageToSessionTranscript,
  loadSessionStore,
  mergeSessionEntry,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { unbindThreadBindingsBySessionKey } from "../../discord/monitor/thread-bindings.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsHygieneParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  deriveSessionTitle,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
  readSessionMessages,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_HYGIENE_EVENT = "session.hygiene";
const SESSION_HYGIENE_BOUNDED_COPY_THRESHOLD_BYTES = 1_500_000;
const SESSION_HYGIENE_BOUNDED_COPY_MAX_BYTES = 750_000;

type SessionHygienePhase =
  | "starting"
  | "resolving-transcript"
  | "preparing-working-copy"
  | "compacting"
  | "writing-cleaned-session"
  | "creating-continuation"
  | "seeding-continuation"
  | "completed"
  | "failed";

type SessionHygieneMode = "clean" | "compacted-continuation";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function migrateAndPruneSessionStoreKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  if (!params.store[primaryKey]) {
    const existingKey = target.storeKeys.find((candidate) => Boolean(params.store[candidate]));
    if (existingKey) {
      params.store[primaryKey] = params.store[existingKey];
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscripts({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  unbindThreadBindingsBySessionKey({
    targetSessionKey: params.targetSessionKey,
    targetKind,
    reason: params.reason,
    sendFarewell: true,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}) {
  const closeTrackedBrowserTabs = async () => {
    const closeKeys = new Set<string>([
      params.key,
      params.target.canonicalKey,
      ...params.target.storeKeys,
      params.sessionId ?? "",
    ]);
    return await closeTrackedBrowserTabsForSessions({
      sessionKeys: [...closeKeys],
      onWarn: (message) => logVerbose(message),
    });
  };

  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionQueues([...queueKeys]);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  abortEmbeddedPiRun(params.sessionId);
  const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended) {
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
  if (!params.entry?.acp) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      });
    },
  });
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  return undefined;
}

async function cleanupSessionBeforeMutation(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    target: params.target,
    sessionId: params.entry?.sessionId,
  });
  if (cleanupError) {
    return cleanupError;
  }
  return await closeAcpRuntimeForSession({
    cfg: params.cfg,
    sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
    entry: params.entry,
    reason: params.reason,
  });
}

function resolveHygieneAgentId(params: {
  cfg: ReturnType<typeof loadConfig>;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  key: string;
}) {
  const parsed = parseAgentSessionKey(params.target.canonicalKey ?? params.key);
  return normalizeAgentId(
    parsed?.agentId ?? params.target.agentId ?? resolveDefaultAgentId(params.cfg),
  );
}

function resolveHygieneWorkspaceDir(cfg: ReturnType<typeof loadConfig>, agentId: string) {
  return (
    resolveAgentWorkspaceDir(cfg, agentId) ??
    path.join(os.tmpdir(), "openclaw-session-hygiene", normalizeAgentId(agentId))
  );
}

function resolveSessionTranscriptPath(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
}) {
  return resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  ).find((candidate) => fs.existsSync(candidate));
}

function buildContinuationSessionKey(agentId: string) {
  return `agent:${normalizeAgentId(agentId)}:session-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function buildContinuationLabel(entry: SessionEntry | undefined, continuationSessionKey: string) {
  const title = deriveSessionTitle(entry)?.trim();
  if (title) {
    return `${title} continuation`;
  }
  return `Continuation #${continuationSessionKey.slice(-4).toUpperCase()}`;
}

function buildContinuationEntry(params: {
  sourceEntry: SessionEntry;
  continuationSessionId: string;
  continuationLabel: string;
  resolvedModel: { provider: string; model: string };
}) {
  return mergeSessionEntry(undefined, {
    sessionId: params.continuationSessionId,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    thinkingLevel: params.sourceEntry.thinkingLevel,
    verboseLevel: params.sourceEntry.verboseLevel,
    reasoningLevel: params.sourceEntry.reasoningLevel,
    elevatedLevel: params.sourceEntry.elevatedLevel,
    ttsAuto: params.sourceEntry.ttsAuto,
    execHost: params.sourceEntry.execHost,
    execSecurity: params.sourceEntry.execSecurity,
    execAsk: params.sourceEntry.execAsk,
    execNode: params.sourceEntry.execNode,
    responseUsage: params.sourceEntry.responseUsage,
    providerOverride: params.sourceEntry.providerOverride,
    modelOverride: params.sourceEntry.modelOverride,
    authProfileOverride: params.sourceEntry.authProfileOverride,
    authProfileOverrideSource: params.sourceEntry.authProfileOverrideSource,
    groupActivation: params.sourceEntry.groupActivation,
    groupActivationNeedsSystemIntro: params.sourceEntry.groupActivationNeedsSystemIntro,
    sendPolicy: params.sourceEntry.sendPolicy,
    queueMode: params.sourceEntry.queueMode,
    queueDebounceMs: params.sourceEntry.queueDebounceMs,
    queueCap: params.sourceEntry.queueCap,
    queueDrop: params.sourceEntry.queueDrop,
    modelProvider: params.resolvedModel.provider,
    model: params.resolvedModel.model,
    contextTokens: params.sourceEntry.contextTokens,
    label: params.continuationLabel,
    displayName: params.continuationLabel,
    channel: params.sourceEntry.channel,
    groupId: params.sourceEntry.groupId,
    subject: params.sourceEntry.subject,
    groupChannel: params.sourceEntry.groupChannel,
    space: params.sourceEntry.space,
    origin: snapshotSessionOrigin(params.sourceEntry),
    deliveryContext: params.sourceEntry.deliveryContext,
    lastChannel: params.sourceEntry.lastChannel,
    lastTo: params.sourceEntry.lastTo,
    lastAccountId: params.sourceEntry.lastAccountId,
    lastThreadId: params.sourceEntry.lastThreadId,
    skillsSnapshot: params.sourceEntry.skillsSnapshot,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalTokensFresh: true,
  });
}

async function runSessionHygieneCompaction(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  reasoningLevel?: string;
}) {
  return await compactEmbeddedPiSessionDirect({
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    thinkLevel: normalizeThinkLevel(params.thinkingLevel),
    reasoningLevel: normalizeReasoningLevel(params.reasoningLevel),
    trigger: "manual",
  });
}

function isSessionHygieneConversationNoOp(
  result:
    | {
        ok?: boolean;
        compacted?: boolean;
        reason?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!result?.ok || result.compacted) {
    return false;
  }
  return result.reason?.trim().toLowerCase() === "no real conversation messages";
}

async function runSessionHygieneCompactionWithBoundedFallback(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  sessionId: string;
  sourceTranscriptPath: string;
  initialSessionFile: string;
  usedBoundedCopy: boolean;
  tempDir: string;
  workspaceDir: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  reasoningLevel?: string;
}) {
  let compacted = await runSessionHygieneCompaction({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionFile: params.initialSessionFile,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    reasoningLevel: params.reasoningLevel,
  });

  let sessionFile = params.initialSessionFile;
  let usedBoundedFallback = false;
  if (params.usedBoundedCopy && isSessionHygieneConversationNoOp(compacted)) {
    const fullCopyPath = path.join(params.tempDir, `${params.sessionId}-full.jsonl`);
    fs.copyFileSync(params.sourceTranscriptPath, fullCopyPath);
    compacted = await runSessionHygieneCompaction({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      sessionFile: fullCopyPath,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      reasoningLevel: params.reasoningLevel,
    });
    sessionFile = fullCopyPath;
    usedBoundedFallback = true;
  }

  return {
    compacted,
    sessionFile,
    usedBoundedFallback,
  };
}

type SessionHygieneBudgetDetails = {
  tokensBefore: number | null;
  budgetTokens: number | null;
  contextWindowTokens: number | null;
  maxHistoryShare: number | null;
};

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

function resolveSessionHygieneBudgetDetails(params: {
  cfg: ReturnType<typeof loadConfig>;
  provider: string;
  model: string;
  result?: { tokensBefore?: number };
}): SessionHygieneBudgetDetails {
  const tokensBefore =
    typeof params.result?.tokensBefore === "number" && Number.isFinite(params.result.tokensBefore)
      ? Math.max(0, Math.floor(params.result.tokensBefore))
      : null;
  const maxHistoryShare = params.cfg.agents?.defaults?.compaction?.maxHistoryShare ?? 0.5;
  const contextWindowTokens = resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.model,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
  return {
    tokensBefore,
    budgetTokens: Math.max(1, Math.floor(contextWindowTokens * maxHistoryShare)),
    contextWindowTokens,
    maxHistoryShare,
  };
}

function buildSessionHygieneNoOpReason(params: {
  cfg: ReturnType<typeof loadConfig>;
  provider: string;
  model: string;
  result?: { tokensBefore?: number };
  reason?: string;
}): { summary: string; detail: string | null; budget: SessionHygieneBudgetDetails } {
  const budget = resolveSessionHygieneBudgetDetails({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    result: params.result,
  });
  const before = formatTokenCount(budget.tokensBefore);
  const budgetTokens = formatTokenCount(budget.budgetTokens);
  const windowTokens = formatTokenCount(budget.contextWindowTokens);
  const sharePercent =
    typeof budget.maxHistoryShare === "number" && Number.isFinite(budget.maxHistoryShare)
      ? Math.round(budget.maxHistoryShare * 100)
      : null;
  if (before && budgetTokens) {
    return {
      summary: `No compaction needed: ${before} estimated history tokens already fit within the ${budgetTokens}-token compaction budget.`,
      detail:
        `Current history is already within budget (${before} <= ${budgetTokens} tokens)` +
        (sharePercent && windowTokens
          ? `, which keeps history under ${sharePercent}% of the ${windowTokens}-token context window.`
          : "."),
      budget,
    };
  }
  const reason = params.reason?.trim();
  return {
    summary: reason
      ? `No compaction needed: ${reason}.`
      : "No compaction needed: current history is already within the compaction budget.",
    detail: null,
    budget,
  };
}

function buildSessionHygieneSuccessResult(params: {
  mode: "clean" | "compacted-continuation";
  sessionKey: string;
  compacted: boolean;
  summary: string;
  detail?: string | null;
  budget?: SessionHygieneBudgetDetails;
  continuationSessionKey?: string | null;
}) {
  const continuationSessionKey = params.continuationSessionKey ?? null;
  return {
    ok: true as const,
    mode: params.mode,
    sessionKey: params.sessionKey,
    continuationSessionKey,
    compacted: params.compacted,
    message: params.summary,
    summary: params.summary,
    detail: params.detail ?? null,
    budget: params.budget,
    continuation: continuationSessionKey
      ? {
          sessionKey: continuationSessionKey,
          message: params.summary,
        }
      : undefined,
  };
}

function broadcastSessionHygieneEvent(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  payload: Record<string, unknown>;
}) {
  if (params.client?.connId) {
    params.context.broadcastToConnIds(
      SESSION_HYGIENE_EVENT,
      params.payload,
      new Set([params.client.connId]),
      {
        dropIfSlow: true,
      },
    );
    return;
  }
  params.context.broadcast(SESSION_HYGIENE_EVENT, params.payload, { dropIfSlow: true });
}

function createSessionHygieneProgressReporter(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  sessionKey: string;
  mode: SessionHygieneMode;
}) {
  const emit = (payload: {
    phase: SessionHygienePhase;
    status?: "running" | "completed" | "failed";
    summary: string;
    detail?: string | null;
    step?: number | null;
    totalSteps?: number | null;
    compacted?: boolean | null;
    continuationSessionKey?: string | null;
  }) => {
    broadcastSessionHygieneEvent({
      context: params.context,
      client: params.client,
      payload: {
        sessionKey: params.sessionKey,
        mode: params.mode,
        phase: payload.phase,
        status:
          payload.status ??
          (payload.phase === "failed"
            ? "failed"
            : payload.phase === "completed"
              ? "completed"
              : "running"),
        summary: payload.summary,
        detail: payload.detail ?? null,
        step: payload.step ?? null,
        totalSteps: payload.totalSteps ?? null,
        compacted: payload.compacted ?? null,
        continuationSessionKey: payload.continuationSessionKey ?? null,
        updatedAt: Date.now(),
      },
    });
  };
  return {
    emit,
    fail: (summary: string, detail?: string | null) =>
      emit({ phase: "failed", status: "failed", summary, detail }),
    complete: (
      summary: string,
      opts?: {
        detail?: string | null;
        compacted?: boolean | null;
        continuationSessionKey?: string | null;
      },
    ) =>
      emit({
        phase: "completed",
        status: "completed",
        summary,
        detail: opts?.detail,
        compacted: opts?.compacted,
        continuationSessionKey: opts?.continuationSessionKey,
      }),
  };
}

function readTranscriptTailChunk(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    return "";
  }
  const bytesToRead = Math.max(1, Math.min(Math.trunc(maxBytes), stat.size));
  const start = Math.max(0, stat.size - bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, start);
    if (bytesRead <= 0) {
      return "";
    }
    let chunk = buf.toString("utf-8", 0, bytesRead);
    if (start > 0) {
      const firstNewline = chunk.indexOf("\n");
      chunk = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : "";
    }
    return chunk.trim() ? `${chunk.trimEnd()}\n` : "";
  } finally {
    fs.closeSync(fd);
  }
}

function createBoundedSessionHygieneWorkingCopy(params: {
  sourcePath: string;
  tempDir: string;
  maxBytes?: number;
}) {
  const chunk = readTranscriptTailChunk(
    params.sourcePath,
    params.maxBytes ?? SESSION_HYGIENE_BOUNDED_COPY_MAX_BYTES,
  );
  if (!chunk.trim()) {
    return null;
  }
  const filePath = path.join(params.tempDir, `${randomUUID()}.jsonl`);
  fs.writeFileSync(filePath, chunk, "utf-8");
  return filePath;
}

function createSessionHygieneWorkingCopy(params: {
  sourcePath: string;
  tempDir: string;
  sessionId: string;
}) {
  const workingCopyPath = path.join(params.tempDir, `${params.sessionId}.jsonl`);
  let bounded = false;
  const stat = fs.statSync(params.sourcePath);
  if (stat.size >= SESSION_HYGIENE_BOUNDED_COPY_THRESHOLD_BYTES) {
    const boundedCopyPath = createBoundedSessionHygieneWorkingCopy({
      sourcePath: params.sourcePath,
      tempDir: params.tempDir,
    });
    if (boundedCopyPath) {
      fs.renameSync(boundedCopyPath, workingCopyPath);
      bounded = true;
    }
  }
  if (!fs.existsSync(workingCopyPath)) {
    fs.copyFileSync(params.sourcePath, workingCopyPath);
  }
  return { workingCopyPath, bounded };
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const hadExistingEntry = Boolean(entry);
    const commandReason = p.reason === "new" ? "new" : "reset";
    const hookEvent = createInternalHookEvent(
      "command",
      commandReason,
      target.canonicalKey ?? key,
      {
        sessionEntry: entry,
        previousSessionEntry: entry,
        commandSource: "gateway:sessions.reset",
        cfg,
      },
    );
    await triggerInternalHook(hookEvent);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-reset",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    let oldSessionId: string | undefined;
    let oldSessionFile: string | undefined;
    const next = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const entry = store[primaryKey];
      const parsed = parseAgentSessionKey(primaryKey);
      const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
      const resolvedModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
      oldSessionId = entry?.sessionId;
      oldSessionFile = entry?.sessionFile;
      const now = Date.now();
      const nextEntry: SessionEntry = {
        sessionId: randomUUID(),
        updatedAt: now,
        systemSent: false,
        abortedLastRun: false,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        responseUsage: entry?.responseUsage,
        model: resolvedModel.model,
        modelProvider: resolvedModel.provider,
        contextTokens: entry?.contextTokens,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalTokensFresh: true,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    // Archive old transcript so it doesn't accumulate on disk (#14869).
    archiveSessionTranscriptsForSession({
      sessionId: oldSessionId,
      storePath,
      sessionFile: oldSessionFile,
      agentId: target.agentId,
      reason: "reset",
    });
    if (hadExistingEntry) {
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-reset",
      });
    }
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
  },
  "sessions.get": ({ params, respond }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const store = loadSessionStore(storePath);
    const entry = target.storeKeys.map((k) => store[k]).find(Boolean);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const messages = limit < allMessages.length ? allMessages.slice(-limit) : allMessages;
    respond(true, { messages }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },
  "sessions.hygiene": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsHygieneParams, "sessions.hygiene", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.sessionKey, respond);
    if (!key) {
      return;
    }
    const progress = createSessionHygieneProgressReporter({
      context,
      client,
      sessionKey: key,
      mode: p.mode,
    });
    progress.emit({
      phase: "starting",
      summary: "Starting session hygiene…",
      step: 1,
      totalSteps: 5,
    });

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const canonicalSessionKey = target.canonicalKey ?? key;
    progress.emit({
      phase: "resolving-transcript",
      summary: "Resolving current session transcript…",
      detail: canonicalSessionKey === key ? null : `Resolved ${key} to ${canonicalSessionKey}.`,
      step: 2,
      totalSteps: 5,
    });
    const { entry } = loadSessionEntry(canonicalSessionKey);
    if (!entry?.sessionId) {
      const summary = "No session transcript was available to compact.";
      progress.complete(summary, { compacted: false });
      respond(
        true,
        {
          ok: true,
          mode: p.mode,
          sessionKey: canonicalSessionKey,
          continuationSessionKey: null,
          compacted: false,
          message: summary,
          summary,
        },
        undefined,
      );
      return;
    }

    const transcriptPath = resolveSessionTranscriptPath({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: target.agentId,
    });
    if (!transcriptPath) {
      const summary = "No session transcript was available to compact.";
      progress.complete(summary, { compacted: false });
      respond(
        true,
        {
          ok: true,
          mode: p.mode,
          sessionKey: canonicalSessionKey,
          continuationSessionKey: null,
          compacted: false,
          message: summary,
          summary,
        },
        undefined,
      );
      return;
    }

    const agentId = resolveHygieneAgentId({ cfg, target, key: canonicalSessionKey });
    const workspaceDir = resolveHygieneWorkspaceDir(cfg, agentId);
    const resolvedModel = resolveSessionModelRef(cfg, entry, agentId);

    if (p.mode === "clean") {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-hygiene-"));
      try {
        const compactSessionId = randomUUID();
        progress.emit({
          phase: "preparing-working-copy",
          summary: "Preparing a working copy for cleanup…",
          step: 3,
          totalSteps: 5,
        });
        const { workingCopyPath, bounded } = createSessionHygieneWorkingCopy({
          sourcePath: transcriptPath,
          tempDir: tmpDir,
          sessionId: compactSessionId,
        });
        progress.emit({
          phase: "compacting",
          summary: "Compacting recent session history…",
          detail: bounded
            ? "Using a bounded working copy for faster cleanup."
            : "Using a full working copy before swapping the cleaned transcript into place.",
          step: 4,
          totalSteps: 5,
        });
        const compactionRun = await runSessionHygieneCompactionWithBoundedFallback({
          cfg,
          sessionKey: canonicalSessionKey,
          sessionId: compactSessionId,
          sourceTranscriptPath: transcriptPath,
          initialSessionFile: workingCopyPath,
          usedBoundedCopy: bounded,
          tempDir: tmpDir,
          workspaceDir,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          thinkingLevel: entry.thinkingLevel,
          reasoningLevel: entry.reasoningLevel,
        });
        const compacted = compactionRun.compacted;
        if (!compacted.ok) {
          progress.fail("Session hygiene failed.", compacted.reason || null);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, compacted.reason || "Session hygiene failed."),
          );
          return;
        }
        if (compacted.compacted || !bounded || compactionRun.usedBoundedFallback) {
          progress.emit({
            phase: "writing-cleaned-session",
            summary: "Writing cleaned session back to the live transcript…",
            detail: compactionRun.usedBoundedFallback
              ? "Replacing the current transcript with a full working copy after retrying the bounded cleanup path."
              : bounded
                ? "Replacing the current transcript with the compacted working copy."
                : "Replacing the current transcript with the cleaned working copy.",
            step: 5,
            totalSteps: 5,
            compacted: compacted.compacted,
          });
          fs.copyFileSync(compactionRun.sessionFile, transcriptPath);
        }
        const summary =
          compacted.result?.summary?.trim() ||
          (compacted.compacted
            ? "Current session cleaned."
            : buildSessionHygieneNoOpReason({
                cfg,
                provider: resolvedModel.provider,
                model: resolvedModel.model,
                result: compacted.result,
                reason: compacted.reason,
              }).summary);
        const noOpReason = compacted.compacted
          ? null
          : buildSessionHygieneNoOpReason({
              cfg,
              provider: resolvedModel.provider,
              model: resolvedModel.model,
              result: compacted.result,
              reason: compacted.reason,
            });
        progress.complete(summary, {
          compacted: compacted.compacted,
          detail: compacted.compacted
            ? compactionRun.usedBoundedFallback
              ? "Live session cleanup retried from a full working copy after the bounded copy looked empty."
              : bounded
                ? "Live session cleanup ran against a bounded working copy."
                : "Live session cleanup completed from a temporary working copy."
            : noOpReason?.detail,
        });
        respond(
          true,
          buildSessionHygieneSuccessResult({
            mode: p.mode,
            sessionKey: canonicalSessionKey,
            continuationSessionKey: null,
            compacted: compacted.compacted,
            summary,
            detail: compacted.compacted ? null : noOpReason?.detail,
            budget: noOpReason?.budget,
          }),
          undefined,
        );
        return;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-hygiene-"));
    try {
      const compactSessionId = randomUUID();
      progress.emit({
        phase: "preparing-working-copy",
        summary: "Preparing a temporary transcript copy…",
        detail: "The current session stays unchanged while the continuation is built.",
        step: 3,
        totalSteps: 6,
      });
      const { workingCopyPath: compactSessionFile, bounded } = createSessionHygieneWorkingCopy({
        sourcePath: transcriptPath,
        tempDir: tmpDir,
        sessionId: compactSessionId,
      });

      progress.emit({
        phase: "compacting",
        summary: "Compacting recent session history…",
        detail: bounded
          ? "Using a bounded working copy so continuation compaction stays focused on the recent transcript tail."
          : "Building the continuation summary from a full temporary transcript copy.",
        step: 4,
        totalSteps: 6,
      });
      const compactionRun = await runSessionHygieneCompactionWithBoundedFallback({
        cfg,
        sessionKey: canonicalSessionKey,
        sessionId: compactSessionId,
        sourceTranscriptPath: transcriptPath,
        initialSessionFile: compactSessionFile,
        usedBoundedCopy: bounded,
        tempDir: tmpDir,
        workspaceDir,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        thinkingLevel: entry.thinkingLevel,
        reasoningLevel: entry.reasoningLevel,
      });
      const compacted = compactionRun.compacted;
      if (!compacted.ok) {
        progress.fail("Session hygiene failed.", compacted.reason || null);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, compacted.reason || "Session hygiene failed."),
        );
        return;
      }

      const summary =
        compacted.result?.summary?.trim() ||
        (compacted.compacted
          ? "Compacted continuation created."
          : buildSessionHygieneNoOpReason({
              cfg,
              provider: resolvedModel.provider,
              model: resolvedModel.model,
              result: compacted.result,
              reason: compacted.reason,
            }).summary);
      if (!compacted.compacted) {
        const noOpReason = buildSessionHygieneNoOpReason({
          cfg,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          result: compacted.result,
          reason: compacted.reason,
        });
        progress.complete(summary, {
          compacted: false,
          detail: noOpReason.detail,
        });
        respond(
          true,
          buildSessionHygieneSuccessResult({
            mode: p.mode,
            sessionKey: canonicalSessionKey,
            continuationSessionKey: null,
            compacted: false,
            summary,
            detail: noOpReason.detail,
            budget: noOpReason.budget,
          }),
          undefined,
        );
        return;
      }

      const continuationSessionKey = buildContinuationSessionKey(agentId);
      const continuationLabel = buildContinuationLabel(entry, continuationSessionKey);
      const continuationSessionId = randomUUID();
      progress.emit({
        phase: "creating-continuation",
        summary: "Creating compacted continuation…",
        detail: `Creating ${continuationLabel}.`,
        step: 5,
        totalSteps: 6,
        compacted: true,
      });
      await updateSessionStore(storePath, (store) => {
        store[continuationSessionKey] = buildContinuationEntry({
          sourceEntry: entry,
          continuationSessionId,
          continuationLabel,
          resolvedModel,
        });
      });

      progress.emit({
        phase: "seeding-continuation",
        summary: "Seeding continuation transcript…",
        detail: compactionRun.usedBoundedFallback
          ? "Writing the compacted summary into the new continuation after retrying from a full working copy."
          : bounded
            ? "Writing the compacted summary into the new continuation created from the bounded working copy."
            : "Writing the compacted summary into the new continuation transcript.",
        step: 6,
        totalSteps: 6,
        compacted: true,
      });
      const mirrored = await appendAssistantMessageToSessionTranscript({
        agentId,
        storePath,
        sessionKey: continuationSessionKey,
        text: summary,
      });
      if (!mirrored.ok) {
        const removedContinuation = await updateSessionStore(storePath, (store) => {
          const removed = store[continuationSessionKey];
          delete store[continuationSessionKey];
          return removed;
        });
        archiveSessionTranscriptsForSession({
          sessionId: removedContinuation?.sessionId ?? continuationSessionId,
          storePath,
          sessionFile: removedContinuation?.sessionFile,
          agentId,
          reason: "deleted",
        });
        progress.fail(
          "Compacted continuation failed while seeding the new transcript.",
          mirrored.reason,
        );
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Compacted continuation created but transcript seed failed: ${mirrored.reason}`,
          ),
        );
        return;
      }

      progress.complete(summary, {
        compacted: true,
        continuationSessionKey,
      });
      respond(
        true,
        buildSessionHygieneSuccessResult({
          mode: p.mode,
          sessionKey: canonicalSessionKey,
          continuationSessionKey,
          compacted: true,
          summary,
        }),
        undefined,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
};
