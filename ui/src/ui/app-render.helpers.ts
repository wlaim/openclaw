import { html } from "lit";
import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { t } from "../i18n/index.ts";
import { refreshChat } from "./app-chat.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";
import {
  getSessionHygieneOption,
  runSessionHygiene,
  SESSION_HYGIENE_OPTIONS,
  supportsSessionHygiene,
} from "./controllers/session-hygiene.ts";
import { createSession, loadSessions, patchSession } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainSessionKey?: string;
  mainKey?: string;
};

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

export function switchChatSession(
  state: AppViewState,
  sessionKey: string,
  opts?: {
    sessionHygieneResult?: AppViewState["sessionHygieneResult"];
    sessionHygieneError?: string | null;
  },
) {
  const app = state as unknown as OpenClawApp;
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  app.chatAttachments = [];
  app.chatQueue = [];
  state.chatStream = null;
  app.chatStreamStartedAt = null;
  state.chatRunId = null;
  app.sessionHygieneError = opts?.sessionHygieneError ?? null;
  app.sessionHygieneProgress = null;
  app.sessionHygieneResult = opts?.sessionHygieneResult ?? null;
  app.resetToolStream();
  app.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

export async function addIndependentChatSession(state: AppViewState): Promise<string | null> {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const parsed = parseAgentSessionKey(state.sessionKey);
  const created = await createSession(state, {
    agentId: parsed?.agentId ?? snapshot?.sessionDefaults?.defaultAgentId ?? "main",
    basedOn: state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey) ?? null,
  });
  if (!created) {
    return null;
  }

  switchChatSession(state, created.key);
  void state.loadAssistantIdentity();
  void refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
    scheduleScroll: false,
  });
  return created.key;
}

export function renderTab(state: AppViewState, tab: Tab) {
  const href = pathForTab(tab, state.basePath);
  return html`
    <a
      href=${href}
      class="nav-item ${state.tab === tab ? "active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (tab === "chat") {
          const mainSessionKey = resolveSidebarChatSessionKey(state);
          if (state.sessionKey !== mainSessionKey) {
            switchChatSession(state, mainSessionKey);
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
    </a>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      ${
        hiddenCount > 0
          ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: 999px;
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
          >${hiddenCount}</span
          >`
          : ""
      }
    </span>
  `;
}

function renderSessionHygieneStatus(state: AppViewState, supported: boolean) {
  const option = getSessionHygieneOption(state.sessionHygieneMode);
  if (!supported) {
    return html`
      <div class="chat-hygiene__status chat-hygiene__status--muted">
        This gateway has not advertised session hygiene support yet.
      </div>
    `;
  }
  if (state.sessionHygieneBusy && state.sessionHygieneProgress) {
    const progress = state.sessionHygieneProgress;
    const stepLabel =
      progress.step && progress.totalSteps
        ? `Step ${Math.min(progress.step, progress.totalSteps)} of ${progress.totalSteps}`
        : "Working";
    return html`
      <div class="chat-hygiene__status chat-hygiene__status--progress">
        <div class="chat-hygiene__status-head">
          <span>${progress.summary}</span>
          <span class="chat-hygiene__status-step">${stepLabel}</span>
        </div>
        ${progress.detail ? html`<div class="chat-hygiene__status-detail">${progress.detail}</div>` : ""}
      </div>
    `;
  }
  if (state.sessionHygieneError) {
    return html`
      <div class="chat-hygiene__status chat-hygiene__status--error">
        ${state.sessionHygieneError}
      </div>
    `;
  }
  if (!state.sessionHygieneResult) {
    return html`
      <div class="chat-hygiene__status chat-hygiene__status--muted">
        ${
          option.createsContinuation
            ? "Creates a compacted continuation and opens it in chat when the gateway returns the next session key."
            : "Runs cleanup against the current session in place and refreshes the transcript when it completes."
        }
      </div>
    `;
  }

  const result = state.sessionHygieneResult;
  const continuationDetail =
    result.continuationSessionKey && option.createsContinuation
      ? state.sessionKey === result.continuationSessionKey
        ? `Continuation open: ${result.continuationSessionKey}`
        : `Continuation ready: ${result.continuationSessionKey}`
      : null;
  return html`
    <div class="chat-hygiene__status chat-hygiene__status--success">
      <div>${result.summary}</div>
      ${result.detail ? html`<div class="chat-hygiene__status-detail">${result.detail}</div>` : ""}
      ${
        continuationDetail
          ? html`<div class="chat-hygiene__status-detail">${continuationDetail}</div>`
          : ""
      }
    </div>
  `;
}

export function renderChatControls(state: AppViewState) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron
    ? countHiddenCronSessions(state.sessionKey, state.sessionsResult)
    : 0;
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const activeSession = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const renameTitle = resolveSessionDisplayName(state.sessionKey, activeSession);
  const sessionLabel = resolveSessionOptionLabel(state.sessionKey, activeSession);
  const activeModel = activeSession?.model?.trim() || "";
  const modelOptions = Array.from(
    new Set(
      [activeModel, ...(state.chatModelSuggestions ?? []).map((value) => value.trim())].filter(
        Boolean,
      ),
    ),
  ).slice(0, 8);
  const sessionPickerTitle = `Select session${sessionLabel ? `: ${sessionLabel}` : ""}`;
  const modelPickerTitle =
    modelOptions.length > 0
      ? `Select model${activeModel ? `: ${activeModel}` : ""}`
      : "No model overrides available";
  const renameButtonTitle = `Rename session${renameTitle ? `: ${renameTitle}` : ""}`;
  const sessionOptions = resolveSessionOptions(
    state.sessionKey,
    state.sessionsResult,
    resolveMainSessionKey(state.hello, state.sessionsResult),
    state.sessionsHideCron ?? true,
  );
  const sessionHygieneSupported = supportsSessionHygiene(state.hello);
  const sessionHygieneOption = getSessionHygieneOption(state.sessionHygieneMode);
  // Refresh icon
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls" role="toolbar" aria-label="Chat actions">
      <div class="chat-controls__group chat-controls__group--selectors">
        <label
          class="btn btn--sm btn--icon chat-controls__icon-control chat-controls__picker-select"
          title=${sessionPickerTitle}
        >
          <select
            class="chat-controls__native-select"
            aria-label=${sessionPickerTitle}
            .value=${state.sessionKey}
            ?disabled=${!state.connected}
            @change=${(e: Event) => {
              const target = e.target as HTMLSelectElement;
              switchChatSession(state, target.value);
              void state.loadAssistantIdentity();
              void refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
                scheduleScroll: false,
              });
            }}
          >
            ${sessionOptions.map(
              (entry) => html`
                <option value=${entry.key} title=${entry.key}>
                  ${resolveSessionOptionLabel(entry.key, entry.row, { isMain: entry.isMain })}
                </option>
              `,
            )}
          </select>
          <span class="chat-controls__picker-content" aria-hidden="true">
            <span class="chat-controls__control-icon">${icons.messageSquare}</span>
          </span>
        </label>
        <label
          class="btn btn--sm btn--icon chat-controls__icon-control chat-controls__picker-select"
          title=${modelPickerTitle}
        >
          <select
            class="chat-controls__native-select"
            aria-label=${modelPickerTitle}
            .value=${activeModel}
            ?disabled=${!state.connected || modelOptions.length === 0}
            @change=${(e: Event) => {
              const target = e.target as HTMLSelectElement;
              const model = target.value.trim();
              if (!model || model === activeModel) {
                return;
              }
              void patchSession(state, state.sessionKey, { model });
            }}
          >
            ${
              modelOptions.length > 0
                ? modelOptions.map(
                    (model) => html`
                    <option value=${model} title=${model}>
                      ${model}
                    </option>
                  `,
                  )
                : html`
                    <option value="">No model overrides available</option>
                  `
            }
          </select>
          <span class="chat-controls__picker-content" aria-hidden="true">
            <span class="chat-controls__control-icon">${icons.brain}</span>
          </span>
        </label>
      </div>
      <div class="chat-controls__group chat-controls__group--actions">
        <button
          class="btn btn--sm btn--icon chat-controls__icon-control"
          ?disabled=${state.sessionsLoading || !state.connected}
          @click=${() => void addIndependentChatSession(state)}
          title="New thread"
          aria-label="New thread"
        >
          ${icons.plus}
        </button>
        <button
          class="btn btn--sm btn--icon chat-controls__icon-control"
          ?disabled=${!state.connected}
          @click=${async () => {
            const value = window.prompt("Rename this session", renameTitle);
            if (value == null) {
              return;
            }
            const nextLabel = value.trim();
            const currentLabel = activeSession?.label?.trim() || "";
            if (nextLabel === currentLabel) {
              return;
            }
            await patchSession(
              state as unknown as Parameters<typeof patchSession>[0],
              state.sessionKey,
              {
                label: nextLabel || null,
              },
            );
          }}
          title=${renameButtonTitle}
          aria-label=${renameButtonTitle}
        >
          ${icons.edit}
        </button>
        <details class="chat-controls__menu">
          <summary
            class="btn btn--sm btn--icon chat-controls__icon-control"
            title="Session hygiene"
            aria-label="Session hygiene"
          >
            ${icons.sparkles}
          </summary>
          <div class="chat-controls__menu-panel chat-controls__menu-panel--hygiene">
            <div class="chat-hygiene">
              <div class="chat-hygiene__header">
                <div class="chat-hygiene__title">Session hygiene</div>
                <div class="chat-hygiene__copy">
                  Prepare this session for either an in-place cleanup or a compacted handoff.
                </div>
              </div>
              <div class="chat-hygiene__meta" aria-live="polite">
                <div class="chat-hygiene__meta-row">
                  <span class="chat-hygiene__meta-label">Session</span>
                  <span class="chat-hygiene__meta-value">${sessionLabel}</span>
                </div>
                <div class="chat-hygiene__meta-row">
                  <span class="chat-hygiene__meta-label">Request</span>
                  <span class="chat-hygiene__meta-value">
                    ${
                      sessionHygieneOption.createsContinuation
                        ? "create continuation"
                        : "clean in place"
                    }
                  </span>
                </div>
              </div>
              <div class="chat-hygiene__modes" role="listbox" aria-label="Session hygiene mode">
                ${SESSION_HYGIENE_OPTIONS.map(
                  (option) => html`
                    <button
                      class="chat-hygiene__mode ${state.sessionHygieneMode === option.mode ? "active" : ""}"
                      type="button"
                      role="option"
                      aria-selected=${state.sessionHygieneMode === option.mode}
                      ?disabled=${state.sessionHygieneBusy}
                      @click=${() => {
                        state.sessionHygieneMode = option.mode;
                        state.sessionHygieneError = null;
                        state.sessionHygieneProgress = null;
                        state.sessionHygieneResult = null;
                      }}
                    >
                      <span class="chat-hygiene__mode-title">${option.title}</span>
                      <span class="chat-hygiene__mode-copy">${option.description}</span>
                    </button>
                  `,
                )}
              </div>
              <button
                class="btn btn--sm primary chat-hygiene__run"
                type="button"
                ?disabled=${!state.connected || !sessionHygieneSupported || state.sessionHygieneBusy}
                @click=${async () => {
                  const result = await runSessionHygiene(state, state.sessionHygieneMode);
                  if (!result) {
                    return;
                  }
                  await loadSessions(state);
                  if (
                    result.continuationSessionKey &&
                    result.continuationSessionKey !== state.sessionKey
                  ) {
                    switchChatSession(state, result.continuationSessionKey, {
                      sessionHygieneResult: result,
                    });
                    void state.loadAssistantIdentity();
                  }
                  await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
                    scheduleScroll: false,
                  });
                }}
              >
                ${
                  state.sessionHygieneBusy
                    ? sessionHygieneOption.busyLabel
                    : sessionHygieneOption.actionLabel
                }
              </button>
              ${renderSessionHygieneStatus(state, sessionHygieneSupported)}
            </div>
          </div>
        </details>
        <button
          class="btn btn--sm btn--icon chat-controls__icon-control"
          ?disabled=${state.chatLoading || !state.connected}
          @click=${async () => {
            const app = state as unknown as OpenClawApp;
            app.chatManualRefreshInFlight = true;
            app.chatNewMessagesBelow = false;
            await app.updateComplete;
            app.resetToolStream();
            try {
              await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
                scheduleScroll: false,
              });
              app.scrollToBottom({ smooth: true });
            } finally {
              requestAnimationFrame(() => {
                app.chatManualRefreshInFlight = false;
                app.chatNewMessagesBelow = false;
              });
            }
          }}
          title=${t("chat.refreshTitle")}
          aria-label=${t("chat.refreshTitle")}
        >
          ${refreshIcon}
        </button>
        <button
          class="btn btn--sm btn--icon chat-controls__icon-control ${showThinking ? "active" : ""}"
          ?disabled=${disableThinkingToggle}
          @click=${() => {
            if (disableThinkingToggle) {
              return;
            }
            state.applySettings({
              ...state.settings,
              chatShowThinking: !state.settings.chatShowThinking,
            });
          }}
          aria-pressed=${showThinking}
          title=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.thinkingToggle")}
          aria-label=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.thinkingToggle")}
        >
          ${icons.brain}
        </button>
        <button
          class="btn btn--sm btn--icon chat-controls__icon-control ${focusActive ? "active" : ""}"
          ?disabled=${disableFocusToggle}
          @click=${() => {
            if (disableFocusToggle) {
              return;
            }
            state.applySettings({
              ...state.settings,
              chatFocusMode: !state.settings.chatFocusMode,
            });
          }}
          aria-pressed=${focusActive}
          title=${disableFocusToggle ? t("chat.onboardingDisabled") : t("chat.focusToggle")}
          aria-label=${disableFocusToggle ? t("chat.onboardingDisabled") : t("chat.focusToggle")}
        >
          ${focusIcon}
        </button>
        <button
          class="btn btn--sm btn--icon chat-controls__icon-control ${hideCron ? "active" : ""}"
          @click=${() => {
            state.sessionsHideCron = !hideCron;
          }}
          aria-pressed=${hideCron}
          title=${
            hideCron
              ? hiddenCronCount > 0
                ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                : t("chat.showCronSessions")
              : t("chat.hideCronSessions")
          }
          aria-label=${
            hideCron
              ? hiddenCronCount > 0
                ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                : t("chat.showCronSessions")
              : t("chat.hideCronSessions")
          }
        >
          ${renderCronFilterIcon(hiddenCronCount)}
        </button>
      </div>
    </div>
  `;
}

export function resolveMainSessionKey(
  hello: AppViewState["hello"],
  sessions: SessionsListResult | null,
): string | null {
  const snapshot = hello?.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  if (sessions?.sessions?.some((row) => row.key === "main")) {
    return "main";
  }
  return null;
}

/* ── Channel display labels ────────────────────────────── */
const CHANNEL_LABELS: Record<string, string> = {
  bluebubbles: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Parsed type / context extracted from a session key. */
export type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Cron:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

export type SessionIdentityInfo = {
  shortId: string;
  source: "sessionId" | "sessionKey";
  fullValue: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name.  Exported for testing.
 */
export function parseSessionKey(key: string): SessionKeyInfo {
  const normalized = key.toLowerCase();

  // ── Main session ─────────────────────────────────
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // ── Subagent ─────────────────────────────────────
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // ── Cron job ─────────────────────────────────────
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }

  // ── Direct chat  (agent:<x>:<channel>:direct:<id>) ──
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }

  // ── Group chat  (agent:<x>:<channel>:group:<id>) ────
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // ── Channel-prefixed legacy keys (e.g. "bluebubbles:g-…") ──
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // ── Unknown — return key as-is ───────────────────
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
): string {
  const label = row?.label?.trim() || "";
  const displayName = row?.displayName?.trim() || "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) {
      return name;
    }
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  if (label && label !== key) {
    return applyTypedPrefix(label);
  }
  if (displayName && displayName !== key) {
    return applyTypedPrefix(displayName);
  }
  return fallbackName;
}

function compactIdentityValue(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]/g, "");
  const source = cleaned || value.replace(/\s+/g, "");
  if (!source) {
    return "UNKNOWN";
  }
  return source.slice(-6).toUpperCase();
}

export function resolveSessionIdentityInfo(
  key: string,
  row?: SessionsListResult["sessions"][number],
): SessionIdentityInfo {
  const sessionId = row?.sessionId?.trim();
  if (sessionId) {
    return {
      shortId: compactIdentityValue(sessionId),
      source: "sessionId",
      fullValue: sessionId,
    };
  }
  return {
    shortId: compactIdentityValue(key),
    source: "sessionKey",
    fullValue: key,
  };
}

export function resolveSessionOptionLabel(
  key: string,
  row?: SessionsListResult["sessions"][number],
  opts?: { isMain?: boolean },
): string {
  const name = resolveSessionDisplayName(key, row);
  const identity = resolveSessionIdentityInfo(key, row);
  const mainLabel = opts?.isMain ? "Main" : "";
  return [name, mainLabel, `#${identity.shortId}`].filter(Boolean).join(" · ");
}

export function isCronSessionKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  if (!normalized.startsWith("agent:")) {
    return false;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const rest = parts.slice(2).join(":");
  return rest.startsWith("cron:");
}

export type ChatSessionOption = {
  key: string;
  displayName?: string;
  row?: SessionsListResult["sessions"][number];
  isMain?: boolean;
};

export function resolveSessionOptions(
  sessionKey: string,
  sessions: SessionsListResult | null,
  mainSessionKey?: string | null,
  hideCron = false,
) {
  const seen = new Set<string>();
  const options: ChatSessionOption[] = [];

  const resolvedMain = mainSessionKey && sessions?.sessions?.find((s) => s.key === mainSessionKey);
  const resolvedCurrent = sessions?.sessions?.find((s) => s.key === sessionKey);

  // Add main session key first
  if (mainSessionKey) {
    seen.add(mainSessionKey);
    options.push({
      key: mainSessionKey,
      displayName: resolveSessionDisplayName(mainSessionKey, resolvedMain || undefined),
      row: resolvedMain || undefined,
      isMain: true,
    });
  }

  // Add current session key next — always include it even if it's a cron session,
  // so the active session is never silently dropped from the select.
  if (!seen.has(sessionKey)) {
    seen.add(sessionKey);
    options.push({
      key: sessionKey,
      displayName: resolveSessionDisplayName(sessionKey, resolvedCurrent),
      row: resolvedCurrent,
      isMain: sessionKey === mainSessionKey,
    });
  }

  // Add sessions from the result, optionally filtering out cron sessions.
  if (sessions?.sessions) {
    for (const s of sessions.sessions) {
      if (!seen.has(s.key) && !(hideCron && isCronSessionKey(s.key))) {
        seen.add(s.key);
        options.push({
          key: s.key,
          displayName: resolveSessionDisplayName(s.key, s),
          row: s,
          isMain: s.key === mainSessionKey,
        });
      }
    }
  }

  return options;
}

/** Count sessions with a cron: key that would be hidden when hideCron=true. */
function countHiddenCronSessions(sessionKey: string, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  // Don't count the currently active session even if it's a cron.
  return sessions.sessions.filter((s) => isCronSessionKey(s.key) && s.key !== sessionKey).length;
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];

export function renderThemeToggle(state: AppViewState) {
  const index = Math.max(0, THEME_ORDER.indexOf(state.theme));
  const applyTheme = (next: ThemeMode) => (event: MouseEvent) => {
    const element = event.currentTarget as HTMLElement;
    const context: ThemeTransitionContext = { element };
    if (event.clientX || event.clientY) {
      context.pointerClientX = event.clientX;
      context.pointerClientY = event.clientY;
    }
    state.setTheme(next, context);
  };

  return html`
    <div class="theme-toggle" style="--theme-index: ${index};">
      <div class="theme-toggle__track" role="group" aria-label="Theme">
        <span class="theme-toggle__indicator"></span>
        <button
          class="theme-toggle__button ${state.theme === "system" ? "active" : ""}"
          @click=${applyTheme("system")}
          aria-pressed=${state.theme === "system"}
          aria-label="System theme"
          title="System"
        >
          ${renderMonitorIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "light" ? "active" : ""}"
          @click=${applyTheme("light")}
          aria-pressed=${state.theme === "light"}
          aria-label="Light theme"
          title="Light"
        >
          ${renderSunIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "dark" ? "active" : ""}"
          @click=${applyTheme("dark")}
          aria-pressed=${state.theme === "dark"}
          aria-label="Dark theme"
          title="Dark"
        >
          ${renderMoonIcon()}
        </button>
      </div>
    </div>
  `;
}

function renderSunIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v2"></path>
      <path d="M12 20v2"></path>
      <path d="m4.93 4.93 1.41 1.41"></path>
      <path d="m17.66 17.66 1.41 1.41"></path>
      <path d="M2 12h2"></path>
      <path d="M20 12h2"></path>
      <path d="m6.34 17.66-1.41 1.41"></path>
      <path d="m19.07 4.93-1.41 1.41"></path>
    </svg>
  `;
}

function renderMoonIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `;
}

function renderMonitorIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `;
}
