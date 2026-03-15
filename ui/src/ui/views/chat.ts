import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackIndicatorStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  modelSuggestions?: string[];
  activeModel?: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  fallbackStatus?: FallbackIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  sessionOptions?: ChatSessionOption[];
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onModelSelect?: (model: string) => void;
  onQueueRemove: (id: string) => void;
  onAddSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

export function resetChatViewState() {
  // Chat view rendering is currently driven entirely by app state.
}

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "";
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function renderFallbackIndicator(status: FallbackIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div
      class=${className}
      role="status"
      aria-live="polite"
      title=${details}
    >
      ${icon} ${message}
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

function renderMobileCompactControls(props: ChatProps) {
  const refreshIcon = html`
    <svg viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg viewBox="0 0 24 24">
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;

  return html`
    <div class="chat-mobile-toolbar" aria-label="Chat controls">
      <button
        class="btn btn--sm chat-mobile-toolbar__action"
        type="button"
        ?disabled=${!props.connected}
        @click=${props.onAddSession}
        title="New thread"
        aria-label="New thread"
      >
        New
      </button>

      <button
        class="btn btn--sm btn--icon chat-mobile-toolbar__icon"
        type="button"
        ?disabled=${!props.connected}
        @click=${props.onRefresh}
        title="Refresh chat"
        aria-label="Refresh chat"
      >
        ${refreshIcon}
      </button>

      <button
        class="btn btn--sm btn--icon chat-mobile-toolbar__icon ${props.focusMode ? "active" : ""}"
        type="button"
        @click=${props.onToggleFocusMode}
        title=${props.focusMode ? "Exit focus mode" : "Enter focus mode"}
        aria-label=${props.focusMode ? "Exit focus mode" : "Enter focus mode"}
      >
        ${focusIcon}
      </button>
    </div>
  `;
}

function renderComposerCompactControls(_props: ChatProps) {
  return nothing;
}

function isMobileViewport(): boolean {
  return globalThis.matchMedia?.("(max-width: 600px)").matches ?? false;
}

function getEmptyStateCopy(props: ChatProps): {
  title: string;
  detail: string;
  status: string;
} {
  if (!props.connected || props.disabledReason) {
    return {
      title: "Chat disconnected",
      detail: "Reconnect the gateway to resume this session and continue the conversation.",
      status: "Offline",
    };
  }

  if (props.error) {
    return {
      title: "Transcript unavailable",
      detail: "The session is open, but the transcript could not be loaded cleanly yet.",
      status: "Needs attention",
    };
  }

  return {
    title: "No messages yet",
    detail: "This session is ready. Send a message below to start the conversation.",
    status: "Ready",
  };
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };
  const composePlaceholder = "Input here";
  const mobileViewport = isMobileViewport();

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const chatItems = buildChatItems(props);
  const emptyDesktopState = !props.loading && chatItems.length === 0 && !mobileViewport;
  const threadLead = html`
    ${
      props.disabledReason
        ? html`
            <div class="chat-thread__notice chat-thread__notice--status callout">
              ${props.disabledReason}
            </div>
          `
        : nothing
    }
    ${props.error ? html`<div class="chat-thread__notice callout danger">${props.error}</div>` : nothing}
    ${
      props.queue.length
        ? html`
            <div class="chat-queue chat-thread__queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${
                          item.text ||
                          (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                        }
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing
    }
    ${renderFallbackIndicator(props.fallbackStatus)}
    ${renderCompactionIndicator(props.compactionStatus)}
  `;
  const emptyState = emptyDesktopState
    ? (() => {
        const copy = getEmptyStateCopy(props);
        return html`
          <div class="chat-empty-state" role="status" aria-live="polite">
            <div class="chat-empty-state__meta">
              <span class="chat-empty-state__eyebrow">${copy.status}</span>
              <span class="chat-empty-state__title">${copy.title}</span>
            </div>
            <p class="chat-empty-state__detail">${copy.detail}</p>
          </div>
        `;
      })()
    : nothing;

  const thread = html`
    <div
      class="chat-thread ${emptyDesktopState ? "chat-thread--empty" : ""}"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      <div class="chat-thread__inner">
        ${emptyDesktopState ? emptyState : threadLead}
        ${
          props.loading
            ? html`
                <div class="muted">Loading chat…</div>
              `
            : nothing
        }
        ${repeat(
          chatItems,
          (item) => item.key,
          (item) => {
            if (item.kind === "divider") {
              return html`
                <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                  <span class="chat-divider__line"></span>
                  <span class="chat-divider__label">${item.label}</span>
                  <span class="chat-divider__line"></span>
                </div>
              `;
            }

            if (item.kind === "reading-indicator") {
              return renderReadingIndicatorGroup(assistantIdentity);
            }

            if (item.kind === "stream") {
              return renderStreamingGroup(
                item.text,
                item.startedAt,
                props.onOpenSidebar,
                assistantIdentity,
              );
            }

            if (item.kind === "group") {
              return renderMessageGroup(item, {
                onOpenSidebar: props.onOpenSidebar,
                showReasoning,
                assistantName: props.assistantName,
                assistantAvatar: assistantIdentity.avatar,
              });
            }

            return nothing;
          },
        )}
      </div>
    </div>
  `;

  return html`
    <section class="card chat">
      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      <div class="chat-shell">
        <div class="chat-stage">
          <div
            class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
          >
            <div
              class="chat-main"
              style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
            >
              ${renderMobileCompactControls(props)}
              ${thread}
            </div>

            ${
              sidebarOpen
                ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio}
                    @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
                  ></resizable-divider>
                  <div class="chat-sidebar">
                    ${renderMarkdownSidebar({
                      content: props.sidebarContent ?? null,
                      error: props.sidebarError ?? null,
                      onClose: props.onCloseSidebar!,
                      onViewRawText: () => {
                        if (!props.sidebarContent || !props.onOpenSidebar) {
                          return;
                        }
                        props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                      },
                    })}
                  </div>
                `
                : nothing
            }
          </div>
        </div>

        ${
          props.showNewMessages
            ? html`
              <button
                class="btn chat-new-messages"
                type="button"
                @click=${props.onScrollToBottom}
              >
                New messages ${icons.arrowDown}
              </button>
            `
            : nothing
        }

        <div class="chat-compose">
          ${renderAttachmentPreview(props)}
          <div class="chat-compose__row">
            <div class="chat-compose__zone chat-compose__zone--controls">
              ${renderComposerCompactControls(props)}
            </div>
            <div class="field chat-compose__field">
              <div class="chat-compose__input-shell">
                <textarea
                  ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
                  .value=${props.draft}
                  dir=${detectTextDirection(props.draft)}
                  aria-label="Input here"
                  ?disabled=${!props.connected}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key !== "Enter") {
                      return;
                    }
                    if (e.isComposing || e.keyCode === 229) {
                      return;
                    }
                    if (e.shiftKey) {
                      return;
                    } // Allow Shift+Enter for line breaks
                    if (!props.connected) {
                      return;
                    }
                    e.preventDefault();
                    if (canCompose) {
                      props.onSend();
                    }
                  }}
                  @input=${(e: Event) => {
                    const target = e.target as HTMLTextAreaElement;
                    adjustTextareaHeight(target);
                    props.onDraftChange(target.value);
                  }}
                  @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
                  placeholder=${composePlaceholder}
                ></textarea>
                ${
                  canAbort
                    ? html`
                      <button
                        class="chat-compose__stop"
                        type="button"
                        ?disabled=${!props.connected}
                        @click=${props.onAbort}
                        aria-label="Stop generating"
                        title="Stop generating"
                      >
                        <span class="chat-compose__stop-icon" aria-hidden="true"></span>
                        <span class="chat-compose__stop-label">Stop</span>
                      </button>
                    `
                    : nothing
                }
              </div>
            </div>
            <div class="chat-compose__zone chat-compose__zone--send">
              <div class="chat-compose__actions">
                <button
                  class="btn primary chat-compose__send"
                  ?disabled=${!props.connected}
                  @click=${props.onSend}
                >
                  ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel = role.toLowerCase() === "user" ? (normalized.senderLabel ?? null) : null;
    const timestamp = normalized.timestamp || Date.now();

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (role.toLowerCase() === "user" && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  // Interleave stream segments and tool cards in order. Each segment
  // contains text that was streaming before the corresponding tool started.
  // This ensures correct visual ordering: text → tool → text → tool → ...
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length && segments[i].text.trim().length > 0) {
      items.push({
        kind: "stream" as const,
        key: `stream-seg:${props.sessionKey}:${i}`,
        text: segments[i].text,
        startedAt: segments[i].ts,
      });
    }
    if (i < tools.length) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
