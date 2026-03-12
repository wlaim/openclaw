import { describe, expect, it, vi } from "vitest";
import {
  applySessionHygieneProgressEvent,
  SESSION_HYGIENE_EVENT,
  runSessionHygiene,
  SESSION_HYGIENE_METHOD,
  supportsSessionHygiene,
  type SessionHygieneState,
} from "./session-hygiene.ts";

function createState(
  request: (method: string, params?: unknown) => Promise<unknown>,
  overrides: Partial<SessionHygieneState> = {},
): SessionHygieneState {
  return {
    client: { request } as unknown as SessionHygieneState["client"],
    connected: true,
    sessionKey: "main",
    hello: {
      type: "hello-ok",
      protocol: 1,
      features: { methods: [SESSION_HYGIENE_METHOD], events: [] },
    },
    sessionHygieneBusy: false,
    sessionHygieneMode: "clean",
    sessionHygieneError: null,
    sessionHygieneProgress: null,
    sessionHygieneResult: null,
    ...overrides,
  };
}

describe("supportsSessionHygiene", () => {
  it("detects the advertised gateway method", () => {
    expect(
      supportsSessionHygiene({
        type: "hello-ok",
        protocol: 1,
        features: { methods: [SESSION_HYGIENE_METHOD], events: [] },
      }),
    ).toBe(true);
    expect(
      supportsSessionHygiene({
        type: "hello-ok",
        protocol: 1,
        features: { methods: ["sessions.list"], events: [] },
      }),
    ).toBe(false);
  });
});

describe("runSessionHygiene", () => {
  it("sends the expected hygiene request and stores the normalized result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T00:00:00Z"));
    const request = vi.fn(async () => ({
      message: "Session compacted and ready.",
    }));
    const state = createState(request);

    const result = await runSessionHygiene(state, "clean");

    expect(request).toHaveBeenCalledWith(SESSION_HYGIENE_METHOD, {
      sessionKey: "main",
      mode: "clean",
    });
    expect(result).toEqual({
      mode: "clean",
      sessionKey: "main",
      continuationSessionKey: null,
      message: "Session compacted and ready.",
      summary: "Session compacted and ready.",
      detail: null,
      completedAt: Date.parse("2026-03-12T00:00:00Z"),
    });
    expect(state.sessionHygieneResult).toEqual(result);
    expect(state.sessionHygieneError).toBeNull();
    expect(state.sessionHygieneBusy).toBe(false);
    expect(state.sessionHygieneProgress?.status).toBe("completed");
    vi.useRealTimers();
  });

  it("accepts continuation-shaped responses and surfaces the next session key", async () => {
    const request = vi.fn(async () => ({
      continuation: {
        sessionKey: "agent:main:session-next",
        message: "Continuation prepared",
      },
    }));
    const state = createState(request, { sessionKey: "agent:main:session-current" });

    const result = await runSessionHygiene(state, "compacted-continuation");

    expect(result?.continuationSessionKey).toBe("agent:main:session-next");
    expect(result?.sessionKey).toBe("agent:main:session-current");
    expect(result?.summary).toBe("Continuation prepared");
  });

  it("preserves detailed no-op reasoning returned by the backend", async () => {
    const request = vi.fn(async () => ({
      summary:
        "No compaction needed: 120 estimated history tokens already fit within the 64,000-token compaction budget.",
      detail:
        "Current history is already within budget (120 <= 64,000 tokens), which keeps history under 50% of the 128,000-token context window.",
    }));
    const state = createState(request);

    const result = await runSessionHygiene(state, "clean");

    expect(result?.summary).toContain("No compaction needed");
    expect(result?.detail).toContain("120 <= 64,000");
    expect(state.sessionHygieneProgress?.detail).toContain("120 <= 64,000");
  });

  it("falls back to a continuation summary when the backend only returns the next session key", async () => {
    const request = vi.fn(async () => ({
      continuationSessionKey: "agent:main:session-next",
    }));
    const state = createState(request, { sessionKey: "agent:main:session-current" });

    const result = await runSessionHygiene(state, "compacted-continuation");

    expect(result?.continuationSessionKey).toBe("agent:main:session-next");
    expect(result?.summary).toBe("Continuation ready: agent:main:session-next");
  });

  it("fails fast when the gateway does not advertise support", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, {
      hello: {
        type: "hello-ok",
        protocol: 1,
        features: { methods: ["sessions.list"], events: [] },
      },
    });

    const result = await runSessionHygiene(state, "clean");

    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(state.sessionHygieneError).toContain("does not advertise session hygiene");
  });

  it("applies live hygiene progress events to the UI state", () => {
    const state = createState(async () => undefined);

    const progress = applySessionHygieneProgressEvent(state, {
      event: SESSION_HYGIENE_EVENT,
      sessionKey: "main",
      mode: "clean",
      phase: "compacting",
      status: "running",
      summary: "Compacting recent session history…",
      detail: "Using a bounded working copy for faster cleanup.",
      step: 3,
      totalSteps: 5,
      updatedAt: Date.parse("2026-03-12T00:00:00Z"),
    });

    expect(progress).toEqual({
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
    });
    expect(state.sessionHygieneProgress).toEqual(progress);
    expect(state.sessionHygieneError).toBeNull();
  });
});
