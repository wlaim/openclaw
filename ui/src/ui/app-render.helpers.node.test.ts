import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  isCronSessionKey,
  parseSessionKey,
  renderChatControls,
  resolveSessionDisplayName,
  resolveSessionIdentityInfo,
  resolveSessionOptionLabel,
  switchChatSession,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

/* ================================================================
 *  parseSessionKey – low-level key → type / fallback mapping
 * ================================================================ */

describe("parseSessionKey", () => {
  it("identifies main session (bare 'main')", () => {
    expect(parseSessionKey("main")).toEqual({ prefix: "", fallbackName: "Main Session" });
  });

  it("identifies main session (agent:main:main)", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({
      prefix: "",
      fallbackName: "Main Session",
    });
  });

  it("identifies subagent sessions", () => {
    expect(parseSessionKey("agent:main:subagent:18abfefe-1fa6-43cb-8ba8-ebdc9b43e253")).toEqual({
      prefix: "Subagent:",
      fallbackName: "Subagent:",
    });
  });

  it("identifies cron sessions", () => {
    expect(parseSessionKey("agent:main:cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
    expect(parseSessionKey("cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  it("identifies direct chat with known channel", () => {
    expect(parseSessionKey("agent:main:bluebubbles:direct:+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage · +19257864429",
    });
  });

  it("identifies direct chat with telegram", () => {
    expect(parseSessionKey("agent:main:telegram:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Telegram · user123",
    });
  });

  it("identifies group chat with known channel", () => {
    expect(parseSessionKey("agent:main:discord:group:guild-chan")).toEqual({
      prefix: "",
      fallbackName: "Discord Group",
    });
  });

  it("capitalises unknown channels in direct/group patterns", () => {
    expect(parseSessionKey("agent:main:mychannel:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Mychannel · user1",
    });
  });

  it("identifies channel-prefixed legacy keys", () => {
    expect(parseSessionKey("bluebubbles:g-agent-main-bluebubbles-direct-+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage Session",
    });
    expect(parseSessionKey("discord:123:456")).toEqual({
      prefix: "",
      fallbackName: "Discord Session",
    });
  });

  it("handles bare channel name as key", () => {
    expect(parseSessionKey("telegram")).toEqual({
      prefix: "",
      fallbackName: "Telegram Session",
    });
  });

  it("returns raw key for unknown patterns", () => {
    expect(parseSessionKey("something-unknown")).toEqual({
      prefix: "",
      fallbackName: "something-unknown",
    });
  });
});

/* ================================================================
 *  resolveSessionDisplayName – full resolution with row data
 * ================================================================ */

describe("resolveSessionDisplayName", () => {
  // ── Key-only fallbacks (no row) ──────────────────

  it("returns 'Main Session' for agent:main:main key", () => {
    expect(resolveSessionDisplayName("agent:main:main")).toBe("Main Session");
  });

  it("returns 'Main Session' for bare 'main' key", () => {
    expect(resolveSessionDisplayName("main")).toBe("Main Session");
  });

  it("returns 'Subagent:' for subagent key without row", () => {
    expect(resolveSessionDisplayName("agent:main:subagent:abc-123")).toBe("Subagent:");
  });

  it("returns 'Cron Job:' for cron key without row", () => {
    expect(resolveSessionDisplayName("agent:main:cron:abc-123")).toBe("Cron Job:");
  });

  it("parses direct chat key with channel", () => {
    expect(resolveSessionDisplayName("agent:main:bluebubbles:direct:+19257864429")).toBe(
      "iMessage · +19257864429",
    );
  });

  it("parses channel-prefixed legacy key", () => {
    expect(resolveSessionDisplayName("discord:123:456")).toBe("Discord Session");
  });

  it("returns raw key for unknown patterns", () => {
    expect(resolveSessionDisplayName("something-custom")).toBe("something-custom");
  });

  // ── With row data (label / displayName) ──────────

  it("returns parsed fallback when row has no label or displayName", () => {
    expect(resolveSessionDisplayName("agent:main:main", row({ key: "agent:main:main" }))).toBe(
      "Main Session",
    );
  });

  it("returns parsed fallback when displayName matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", displayName: "mykey" }))).toBe(
      "mykey",
    );
  });

  it("returns parsed fallback when label matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", label: "mykey" }))).toBe("mykey");
  });

  it("uses label alone when available", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", label: "General" }),
      ),
    ).toBe("General");
  });

  it("falls back to displayName when label is absent", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat" }),
      ),
    ).toBe("My Chat");
  });

  it("prefers label over displayName when both are present", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "General" }),
      ),
    ).toBe("General");
  });

  it("ignores whitespace-only label and falls back to displayName", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "   " }),
      ),
    ).toBe("My Chat");
  });

  it("uses parsed fallback when whitespace-only label and no displayName", () => {
    expect(
      resolveSessionDisplayName("discord:123:456", row({ key: "discord:123:456", label: "   " })),
    ).toBe("Discord Session");
  });

  it("trims label and displayName", () => {
    expect(resolveSessionDisplayName("k", row({ key: "k", label: "  General  " }))).toBe("General");
    expect(resolveSessionDisplayName("k", row({ key: "k", displayName: "  My Chat  " }))).toBe(
      "My Chat",
    );
  });

  // ── Type prefixes applied to labels / displayNames ──

  it("prefixes subagent label with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", label: "maintainer-v2" }),
      ),
    ).toBe("Subagent: maintainer-v2");
  });

  it("prefixes subagent displayName with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
      ),
    ).toBe("Subagent: Task Runner");
  });

  it("prefixes cron label with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
      ),
    ).toBe("Cron: daily-briefing");
  });

  it("prefixes cron displayName with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", displayName: "Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix cron labels that already include Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "Cron: Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix subagent display names that already include Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Subagent: Runner" }),
      ),
    ).toBe("Subagent: Runner");
  });

  it("does not prefix non-typed sessions with labels", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:bluebubbles:direct:+19257864429",
        row({ key: "agent:main:bluebubbles:direct:+19257864429", label: "Tyler" }),
      ),
    ).toBe("Tyler");
  });
});

describe("isCronSessionKey", () => {
  it("returns true for cron: prefixed keys", () => {
    expect(isCronSessionKey("cron:abc-123")).toBe(true);
    expect(isCronSessionKey("cron:weekly-agent-roundtable")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123:run:run-1")).toBe(true);
  });

  it("returns false for non-cron keys", () => {
    expect(isCronSessionKey("main")).toBe(false);
    expect(isCronSessionKey("discord:group:eng")).toBe(false);
    expect(isCronSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
  });
});

describe("resolveSessionIdentityInfo", () => {
  it("prefers the stable sessionId when present", () => {
    expect(
      resolveSessionIdentityInfo(
        "clawclaw",
        row({ key: "clawclaw", sessionId: "sess_9f72-1c55-aa44d2" }),
      ),
    ).toEqual({
      shortId: "AA44D2",
      source: "sessionId",
      fullValue: "sess_9f72-1c55-aa44d2",
    });
  });

  it("falls back to the session key when sessionId is absent", () => {
    expect(resolveSessionIdentityInfo("agent:main:telegram:direct:clawclaw")).toEqual({
      shortId: "AWCLAW",
      source: "sessionKey",
      fullValue: "agent:main:telegram:direct:clawclaw",
    });
  });
});

describe("resolveSessionOptionLabel", () => {
  it("adds a compact identity hint for same-named sessions", () => {
    expect(
      resolveSessionOptionLabel(
        "clawclaw",
        row({ key: "clawclaw", displayName: "clawclaw", sessionId: "sess_9f72-1c55-aa44d2" }),
      ),
    ).toBe("clawclaw · #AA44D2");
  });

  it("marks the main session in the picker label", () => {
    expect(
      resolveSessionOptionLabel(
        "main",
        row({ key: "main", label: "clawclaw", sessionId: "sess_f4ec01" }),
        { isMain: true },
      ),
    ).toBe("clawclaw · Main · #F4EC01");
  });
});

describe("renderChatControls", () => {
  it("renders icon-only header controls with accessible labels", () => {
    const container = document.createElement("div");
    const state = {
      onboarding: false,
      settings: {
        chatShowThinking: false,
        chatFocusMode: false,
      },
      connected: true,
      chatLoading: false,
      sessionsLoading: false,
      sessionsHideCron: true,
      sessionKey: "main",
      sessionsResult: {
        sessions: [
          row({
            key: "main",
            label: "Primary Control Room",
            sessionId: "sess_f4ec01",
            model: "openai/gpt-5.2",
          }),
        ],
      },
      hello: null,
      chatModelSuggestions: ["openai/gpt-5.2", "anthropic/claude-sonnet-4"],
      loadAssistantIdentity: async () => {},
      applySettings: () => {},
    } as unknown as AppViewState;

    render(renderChatControls(state), container);

    const groups = container.querySelectorAll(".chat-controls__group");
    expect(groups).toHaveLength(2);
    expect(container.textContent).not.toContain("Select Session");
    expect(container.textContent).not.toContain("Select Model");
    expect(container.textContent).not.toContain("New Thread");
    expect(container.textContent).not.toContain("Rename");
    expect(container.querySelector('select[aria-label*="Select session"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label*="Select model"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="New thread"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label*="Rename session"]')).not.toBeNull();
    expect(container.querySelector('summary[aria-label="Session hygiene"]')).not.toBeNull();
    expect(container.textContent).toContain("Prepare this session for either an in-place cleanup");
    expect(container.textContent).toContain("Session");
    expect(container.textContent).toContain("Primary Control Room");
    expect(container.textContent).toContain("Request");
    expect(container.textContent).toContain("clean in place");
    expect(container.textContent).toContain("Create compacted continuation");
    expect(container.textContent).toContain(
      "Creates a compacted continuation and opens it in chat",
    );
  });

  it("surfaces continuation results after switching into the new session", () => {
    const container = document.createElement("div");
    const state = {
      onboarding: false,
      settings: {
        chatShowThinking: false,
        chatFocusMode: false,
        sessionKey: "main",
        lastActiveSessionKey: "main",
      },
      connected: true,
      chatLoading: false,
      sessionsLoading: false,
      sessionsHideCron: true,
      sessionKey: "agent:main:session-next",
      sessionsResult: {
        sessions: [
          row({ key: "main", label: "Primary Control Room", sessionId: "sess_f4ec01" }),
          row({
            key: "agent:main:session-next",
            label: "Continuation Thread",
            sessionId: "sess_2b19d0",
          }),
        ],
      },
      hello: {
        type: "hello-ok",
        protocol: 1,
        features: { methods: ["sessions.hygiene"], events: [] },
      },
      chatModelSuggestions: [],
      sessionHygieneMode: "compacted-continuation",
      sessionHygieneBusy: false,
      sessionHygieneError: null,
      sessionHygieneResult: {
        mode: "compacted-continuation",
        sessionKey: "main",
        continuationSessionKey: "agent:main:session-next",
        message: "Compacted continuation created.",
        summary: "Compacted continuation created.",
        detail: "Summary written into the continuation transcript.",
        completedAt: Date.parse("2026-03-12T00:00:00Z"),
      },
      loadAssistantIdentity: async () => {},
      applySettings: () => {},
    } as unknown as AppViewState;

    render(renderChatControls(state), container);

    expect(container.textContent).toContain("Compacted continuation created.");
    expect(container.textContent).toContain("Summary written into the continuation transcript.");
    expect(container.textContent).toContain("Continuation open: agent:main:session-next");
  });

  it("renders live hygiene progress while work is in flight", () => {
    const container = document.createElement("div");
    const state = {
      onboarding: false,
      settings: {
        chatShowThinking: false,
        chatFocusMode: false,
        sessionKey: "main",
        lastActiveSessionKey: "main",
      },
      connected: true,
      chatLoading: false,
      sessionsLoading: false,
      sessionsHideCron: true,
      sessionKey: "main",
      sessionsResult: {
        sessions: [row({ key: "main", label: "Primary Control Room", sessionId: "sess_f4ec01" })],
      },
      hello: {
        type: "hello-ok",
        protocol: 1,
        features: { methods: ["sessions.hygiene"], events: ["session.hygiene"] },
      },
      chatModelSuggestions: [],
      sessionHygieneMode: "clean",
      sessionHygieneBusy: true,
      sessionHygieneError: null,
      sessionHygieneProgress: {
        mode: "clean",
        sessionKey: "main",
        phase: "compacting",
        status: "running",
        summary: "Compacting recent session history…",
        detail: "Using a bounded working copy for faster cleanup.",
        step: 3,
        totalSteps: 5,
        compacted: null,
        continuationSessionKey: null,
        updatedAt: Date.parse("2026-03-12T00:00:00Z"),
      },
      sessionHygieneResult: null,
      loadAssistantIdentity: async () => {},
      applySettings: () => {},
    } as unknown as AppViewState;

    render(renderChatControls(state), container);

    expect(container.textContent).toContain("Compacting recent session history");
    expect(container.textContent).toContain("Step 3 of 5");
    expect(container.textContent).toContain("bounded working copy");
  });
});

describe("switchChatSession", () => {
  it("preserves the hygiene result only when explicitly provided", () => {
    const state = {
      sessionKey: "main",
      chatMessage: "draft",
      chatStream: "stream",
      chatRunId: "run_123",
      settings: {
        sessionKey: "main",
        lastActiveSessionKey: "main",
      },
      chatAttachments: [
        { id: "att-1", dataUrl: "data:image/png;base64,abc", mimeType: "image/png" },
      ],
      chatQueue: [{ id: "q-1", text: "queued", createdAt: 1 }],
      chatStreamStartedAt: 123,
      sessionHygieneError: "old error",
      sessionHygieneProgress: {
        mode: "clean",
        sessionKey: "main",
        phase: "compacting",
        status: "running",
        summary: "Compacting recent session history…",
        detail: null,
        step: 2,
        totalSteps: 5,
        compacted: null,
        continuationSessionKey: null,
        updatedAt: 1,
      },
      sessionHygieneResult: {
        mode: "clean",
        sessionKey: "main",
        continuationSessionKey: null,
        message: "cleaned",
        summary: "cleaned",
        detail: null,
        completedAt: 1,
      },
      applySettings: () => {},
      resetToolStream() {},
      resetChatScroll() {},
    } as unknown as AppViewState;

    const preservedResult = state.sessionHygieneResult;
    switchChatSession(state, "agent:main:session-next", {
      sessionHygieneResult: preservedResult,
    });
    expect(state.sessionHygieneResult).toBe(preservedResult);
    expect(state.sessionHygieneError).toBeNull();
    expect(state.sessionHygieneProgress).toBeNull();

    switchChatSession(state, "main");
    expect(state.sessionHygieneResult).toBeNull();
    expect(state.sessionHygieneError).toBeNull();
    expect(state.sessionHygieneProgress).toBeNull();
  });
});
