import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { rawDataToString } from "../infra/ws.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  connectOk,
  embeddedRunMock,
  installGatewayTestHooks,
  onceMessage,
  piSdkMock,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";

const sessionCleanupMocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
}));

const bootstrapCacheMocks = vi.hoisted(() => ({
  clearBootstrapSnapshot: vi.fn(),
}));

const sessionHookMocks = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(async () => {}),
}));

const subagentLifecycleHookMocks = vi.hoisted(() => ({
  runSubagentEnded: vi.fn(async () => {}),
}));

const subagentLifecycleHookState = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
}));

const threadBindingMocks = vi.hoisted(() => ({
  unbindThreadBindingsBySessionKey: vi.fn((_params?: unknown) => []),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getAcpRuntimeBackend: vi.fn(),
  requireAcpRuntimeBackend: vi.fn(),
}));
const browserSessionTabMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));
const sessionHygieneMocks = vi.hoisted(() => ({
  compactEmbeddedPiSessionDirect: vi.fn(async () => ({
    ok: true,
    compacted: true,
    result: {
      summary: "Compacted summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 60,
    },
  })),
}));

vi.mock("../auto-reply/reply/queue.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/queue.js")>(
    "../auto-reply/reply/queue.js",
  );
  return {
    ...actual,
    clearSessionQueues: sessionCleanupMocks.clearSessionQueues,
  };
});

vi.mock("../auto-reply/reply/abort.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/reply/abort.js")>(
    "../auto-reply/reply/abort.js",
  );
  return {
    ...actual,
    stopSubagentsForRequester: sessionCleanupMocks.stopSubagentsForRequester,
  };
});

vi.mock("../agents/bootstrap-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/bootstrap-cache.js")>();
  return {
    ...actual,
    clearBootstrapSnapshot: bootstrapCacheMocks.clearBootstrapSnapshot,
  };
});

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook: sessionHookMocks.triggerInternalHook,
  };
});

vi.mock("../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/hook-runner-global.js")>();
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(() => ({
      hasHooks: (hookName: string) =>
        hookName === "subagent_ended" && subagentLifecycleHookState.hasSubagentEndedHook,
      runSubagentEnded: subagentLifecycleHookMocks.runSubagentEnded,
    })),
  };
});

vi.mock("../discord/monitor/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../discord/monitor/thread-bindings.js")>();
  return {
    ...actual,
    unbindThreadBindingsBySessionKey: (params: unknown) =>
      threadBindingMocks.unbindThreadBindingsBySessionKey(params),
  };
});

vi.mock("../acp/runtime/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/runtime/registry.js")>();
  return {
    ...actual,
    getAcpRuntimeBackend: acpRuntimeMocks.getAcpRuntimeBackend,
    requireAcpRuntimeBackend: (backendId?: string) => {
      const backend = acpRuntimeMocks.requireAcpRuntimeBackend(backendId);
      if (!backend) {
        throw new Error("missing mocked ACP backend");
      }
      return backend;
    },
  };
});

vi.mock("../browser/session-tab-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/session-tab-registry.js")>();
  return {
    ...actual,
    closeTrackedBrowserTabsForSessions: browserSessionTabMocks.closeTrackedBrowserTabsForSessions,
  };
});

vi.mock("../agents/pi-embedded-runner/compact.runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../agents/pi-embedded-runner/compact.runtime.js")>();
  return {
    ...actual,
    compactEmbeddedPiSessionDirect: sessionHygieneMocks.compactEmbeddedPiSessionDirect,
  };
});

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;
let sharedSessionStoreDir: string;
let sessionStoreCaseSeq = 0;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
  sharedSessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-"));
});

afterAll(async () => {
  await harness.close();
  await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
});

const openClient = async (opts?: Parameters<typeof connectOk>[1]) => await harness.openClient(opts);

async function createSessionStoreDir() {
  const dir = path.join(sharedSessionStoreDir, `case-${sessionStoreCaseSeq++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return { dir, storePath };
}

async function writeSingleLineSession(dir: string, sessionId: string, content: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content })}\n`,
    "utf-8",
  );
}

async function seedActiveMainSession() {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
  return { dir, storePath };
}

function expectActiveRunCleanup(
  requesterSessionKey: string,
  expectedQueueKeys: string[],
  sessionId: string,
) {
  expect(sessionCleanupMocks.stopSubagentsForRequester).toHaveBeenCalledWith({
    cfg: expect.any(Object),
    requesterSessionKey,
  });
  expect(sessionCleanupMocks.clearSessionQueues).toHaveBeenCalledTimes(1);
  const clearedKeys = (
    sessionCleanupMocks.clearSessionQueues.mock.calls as unknown as Array<[string[]]>
  )[0]?.[0];
  expect(clearedKeys).toEqual(expect.arrayContaining(expectedQueueKeys));
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(embeddedRunMock.waitCalls).toEqual([sessionId]);
}

async function getMainPreviewEntry(ws: import("ws").WebSocket) {
  const preview = await rpcReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>(ws, "sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  return entry;
}

async function expectNoMatchingMessage(
  ws: import("ws").WebSocket,
  filter: (obj: { type?: unknown; event?: unknown; payload?: unknown }) => boolean,
  waitMs = 150,
) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve();
    }, waitMs);
    const handler = (data: import("ws").RawData) => {
      const obj = JSON.parse(rawDataToString(data)) as {
        type?: unknown;
        event?: unknown;
        payload?: unknown;
      };
      if (!filter(obj)) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`unexpected message: ${JSON.stringify(obj)}`));
    };
    ws.on("message", handler);
  });
}

describe("gateway server sessions", () => {
  beforeEach(() => {
    sessionCleanupMocks.clearSessionQueues.mockClear();
    sessionCleanupMocks.stopSubagentsForRequester.mockClear();
    bootstrapCacheMocks.clearBootstrapSnapshot.mockReset();
    sessionHookMocks.triggerInternalHook.mockClear();
    subagentLifecycleHookMocks.runSubagentEnded.mockClear();
    subagentLifecycleHookState.hasSubagentEndedHook = true;
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockClear();
    acpRuntimeMocks.cancel.mockClear();
    acpRuntimeMocks.close.mockClear();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue(null);
    acpRuntimeMocks.requireAcpRuntimeBackend.mockReset();
    acpRuntimeMocks.requireAcpRuntimeBackend.mockImplementation((backendId?: string) =>
      acpRuntimeMocks.getAcpRuntimeBackend(backendId),
    );
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockClear();
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockResolvedValue(0);
    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockClear();
    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 60,
      },
    });
  });

  test("lists and patches session store via sessions.* RPC", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const now = Date.now();
    const recent = now - 30_000;
    const stale = now - 15 * 60_000;

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${Array.from({ length: 10 })
        .map((_, idx) => JSON.stringify({ role: "user", content: `line ${idx}` }))
        .join("\n")}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-group.jsonl"),
      `${JSON.stringify({ role: "user", content: "group line 0" })}\n`,
      "utf-8",
    );

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: recent,
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 10,
          outputTokens: 20,
          thinkingLevel: "low",
          verboseLevel: "on",
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "work",
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: stale,
          totalTokens: 50,
        },
        "agent:main:subagent:one": {
          sessionId: "sess-subagent",
          updatedAt: stale,
          spawnedBy: "agent:main:main",
        },
        global: {
          sessionId: "sess-global",
          updatedAt: now - 10_000,
        },
      },
    });

    const { ws, hello } = await openClient();
    expect((hello as { features?: { methods?: string[] } }).features?.methods).toEqual(
      expect.arrayContaining([
        "sessions.list",
        "sessions.preview",
        "sessions.patch",
        "sessions.reset",
        "sessions.delete",
        "sessions.compact",
        "sessions.hygiene",
      ]),
    );

    const resolvedByKey = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolvedByKey.ok).toBe(true);
    expect(resolvedByKey.payload?.key).toBe("agent:main:main");

    const resolvedBySessionId = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      sessionId: "sess-group",
    });
    expect(resolvedBySessionId.ok).toBe(true);
    expect(resolvedBySessionId.payload?.key).toBe("agent:main:discord:group:dev");

    const list1 = await rpcReq<{
      path: string;
      defaults?: { model?: string | null; modelProvider?: string | null };
      sessions: Array<{
        key: string;
        totalTokens?: number;
        totalTokensFresh?: boolean;
        thinkingLevel?: string;
        verboseLevel?: string;
        lastAccountId?: string;
        deliveryContext?: { channel?: string; to?: string; accountId?: string };
      }>;
    }>(ws, "sessions.list", { includeGlobal: false, includeUnknown: false });

    expect(list1.ok).toBe(true);
    expect(list1.payload?.path).toBe(storePath);
    expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
    expect(list1.payload?.defaults?.modelProvider).toBe(DEFAULT_PROVIDER);
    const main = list1.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main?.totalTokens).toBeUndefined();
    expect(main?.totalTokensFresh).toBe(false);
    expect(main?.thinkingLevel).toBe("low");
    expect(main?.verboseLevel).toBe("on");
    expect(main?.lastAccountId).toBe("work");
    expect(main?.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "work",
    });

    const active = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 5,
    });
    expect(active.ok).toBe(true);
    expect(active.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:main"]);

    const limited = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: false,
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    expect(limited.payload?.sessions).toHaveLength(1);
    expect(limited.payload?.sessions[0]?.key).toBe("global");

    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "medium",
      verboseLevel: "off",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:main:main");

    const sendPolicyPatched = await rpcReq<{
      ok: true;
      entry: { sendPolicy?: string };
    }>(ws, "sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
    expect(sendPolicyPatched.ok).toBe(true);
    expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

    const labelPatched = await rpcReq<{
      ok: true;
      entry: { label?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:subagent:one",
      label: "Briefing",
    });
    expect(labelPatched.ok).toBe(true);
    expect(labelPatched.payload?.entry.label).toBe("Briefing");

    const labelPatchedDuplicate = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "Briefing",
    });
    expect(labelPatchedDuplicate.ok).toBe(false);

    const list2 = await rpcReq<{
      sessions: Array<{
        key: string;
        thinkingLevel?: string;
        verboseLevel?: string;
        sendPolicy?: string;
        label?: string;
        displayName?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list2.ok).toBe(true);
    const main2 = list2.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main2?.thinkingLevel).toBe("medium");
    expect(main2?.verboseLevel).toBe("off");
    expect(main2?.sendPolicy).toBe("deny");
    const subagent = list2.payload?.sessions.find((s) => s.key === "agent:main:subagent:one");
    expect(subagent?.label).toBe("Briefing");
    expect(subagent?.displayName).toBe("Briefing");

    const clearedVerbose = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "agent:main:main",
      verboseLevel: null,
    });
    expect(clearedVerbose.ok).toBe(true);

    const list3 = await rpcReq<{
      sessions: Array<{
        key: string;
        verboseLevel?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list3.ok).toBe(true);
    const main3 = list3.payload?.sessions.find((s) => s.key === "agent:main:main");
    expect(main3?.verboseLevel).toBeUndefined();

    const listByLabel = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      label: "Briefing",
    });
    expect(listByLabel.ok).toBe(true);
    expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

    const resolvedByLabel = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      label: "Briefing",
      agentId: "main",
    });
    expect(resolvedByLabel.ok).toBe(true);
    expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

    const spawnedOnly = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      spawnedBy: "agent:main:main",
    });
    expect(spawnedOnly.ok).toBe(true);
    expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

    const spawnedPatched = await rpcReq<{
      ok: true;
      entry: { spawnedBy?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:subagent:two",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatched.ok).toBe(true);
    expect(spawnedPatched.payload?.entry.spawnedBy).toBe("agent:main:main");

    const acpPatched = await rpcReq<{
      ok: true;
      entry: { spawnedBy?: string; spawnDepth?: number };
    }>(ws, "sessions.patch", {
      key: "agent:main:acp:child",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
    });
    expect(acpPatched.ok).toBe(true);
    expect(acpPatched.payload?.entry.spawnedBy).toBe("agent:main:main");
    expect(acpPatched.payload?.entry.spawnDepth).toBe(1);

    const spawnedPatchedInvalidKey = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatchedInvalidKey.ok).toBe(false);

    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    const modelPatched = await rpcReq<{
      ok: true;
      entry: {
        modelOverride?: string;
        providerOverride?: string;
        model?: string;
        modelProvider?: string;
      };
      resolved?: { model?: string; modelProvider?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:main",
      model: "openai/gpt-test-a",
    });
    expect(modelPatched.ok).toBe(true);
    expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
    expect(modelPatched.payload?.entry.providerOverride).toBe("openai");
    expect(modelPatched.payload?.entry.model).toBeUndefined();
    expect(modelPatched.payload?.entry.modelProvider).toBeUndefined();
    expect(modelPatched.payload?.resolved?.modelProvider).toBe("openai");
    expect(modelPatched.payload?.resolved?.model).toBe("gpt-test-a");

    const listAfterModelPatch = await rpcReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterModelPatch.ok).toBe(true);
    const mainAfterModelPatch = listAfterModelPatch.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainAfterModelPatch?.modelProvider).toBe("openai");
    expect(mainAfterModelPatch?.model).toBe("gpt-test-a");

    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
      key: "agent:main:main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    const compactedLines = (await fs.readFile(path.join(dir, "sess-main.jsonl"), "utf-8"))
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(compactedLines).toHaveLength(3);
    const filesAfterCompact = await fs.readdir(dir);
    expect(filesAfterCompact.some((f) => f.startsWith("sess-main.jsonl.bak."))).toBe(true);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    const listAfterDelete = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterDelete.ok).toBe(true);
    expect(
      listAfterDelete.payload?.sessions.some((s) => s.key === "agent:main:discord:group:dev"),
    ).toBe(false);
    const filesAfterDelete = await fs.readdir(dir);
    expect(filesAfterDelete.some((f) => f.startsWith("sess-group.jsonl.deleted."))).toBe(true);

    const reset = await rpcReq<{
      ok: true;
      key: string;
      entry: { sessionId: string; modelProvider?: string; model?: string };
    }>(ws, "sessions.reset", { key: "agent:main:main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");
    const filesAfterReset = await fs.readdir(dir);
    expect(filesAfterReset.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(true);

    const badThinking = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "banana",
    });
    expect(badThinking.ok).toBe(false);
    expect((badThinking.error as { message?: unknown } | undefined)?.message ?? "").toMatch(
      /invalid thinkinglevel/i,
    );

    ws.close();
  });

  test("sessions.preview returns transcript previews", async () => {
    const { dir } = await createSessionStoreDir();
    const sessionId = "sess-preview";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");

    await writeSessionStore({
      entries: {
        main: {
          sessionId,
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(entry?.items[1]?.text).toContain("call weather");

    ws.close();
  });

  test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
    await createSessionStoreDir();
    testState.agentConfig = {
      model: {
        primary: "openai/gpt-test-a",
      },
    };

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-stale-model",
          updatedAt: Date.now(),
          modelProvider: "qwencode",
          model: "qwen3.5-plus-2026-02-15",
          contextTokens: 123456,
        },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{
      ok: true;
      key: string;
      entry: { sessionId: string; modelProvider?: string; model?: string; contextTokens?: number };
    }>(ws, "sessions.reset", { key: "main" });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-model");
    expect(reset.payload?.entry.modelProvider).toBe("openai");
    expect(reset.payload?.entry.model).toBe("gpt-test-a");
    expect(reset.payload?.entry.contextTokens).toBeUndefined();

    ws.close();
  });

  test("sessions.preview resolves legacy mixed-case main alias with custom mainKey", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const sessionId = "sess-legacy-main";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "assistant", content: "Legacy alias transcript" } }),
    ];
    await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:ops:MAIN": {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await openClient();
    const entry = await getMainPreviewEntry(ws);
    expect(entry?.items[0]?.text).toContain("Legacy alias transcript");

    ws.close();
  });

  test("sessions.resolve and mutators clean legacy main-alias ghost keys", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };
    const sessionId = "sess-alias-cleanup";
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(
      transcriptPath,
      `${Array.from({ length: 8 })
        .map((_, idx) => JSON.stringify({ role: "assistant", content: `line ${idx}` }))
        .join("\n")}\n`,
      "utf-8",
    );

    const writeRawStore = async (store: Record<string, unknown>) => {
      await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
    };
    const readStore = async () =>
      JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, Record<string, unknown>>;

    await writeRawStore({
      "agent:ops:MAIN": { sessionId, updatedAt: Date.now() - 2_000 },
      "agent:ops:Main": { sessionId, updatedAt: Date.now() - 1_000 },
    });

    const { ws } = await openClient();

    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");
    let store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
    expect(store["agent:ops:work"]?.thinkingLevel).toBe("medium");

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
      key: "main",
      maxLines: 3,
    });
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    await writeRawStore({
      ...store,
      "agent:ops:MAIN": { ...store["agent:ops:work"] },
    });
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:ops:work");
    store = await readStore();
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

    ws.close();
  });

  test("sessions.delete rejects main and aborts active runs", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSingleLineSession(dir, "sess-active", "active");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:dev": {
          sessionId: "sess-active",
          updatedAt: Date.now(),
        },
      },
    });

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", true);

    const { ws } = await openClient();

    const mainDelete = await rpcReq(ws, "sessions.delete", { key: "main" });
    expect(mainDelete.ok).toBe(false);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expectActiveRunCleanup(
      "agent:main:discord:group:dev",
      ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
      "sess-active",
    );
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: expect.arrayContaining([
        "discord:group:dev",
        "agent:main:discord:group:dev",
        "sess-active",
      ]),
      onWarn: expect.any(Function),
    });
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:discord:group:dev",
        targetKind: "acp",
        reason: "session-delete",
        sendFarewell: true,
        outcome: "deleted",
      },
      {
        childSessionKey: "agent:main:discord:group:dev",
      },
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:discord:group:dev",
      targetKind: "acp",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSingleLineSession(dir, "sess-acp", "acp");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
        "discord:group:dev": {
          sessionId: "sess-acp",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:delete",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
    });
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:main:discord:group:dev",
          backend: "acpx",
          runtimeSessionName: "runtime:delete",
        })),
        runTurn: vi.fn(async function* () {}),
        cancel: acpRuntimeMocks.cancel,
        close: acpRuntimeMocks.close,
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(acpRuntimeMocks.close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:main:discord:group:dev",
        backend: "acpx",
        runtimeSessionName: "runtime:delete",
      },
      reason: "session-delete",
    });
    expect(acpRuntimeMocks.cancel).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:main:discord:group:dev",
        backend: "acpx",
        runtimeSessionName: "runtime:delete",
      },
      reason: "session-delete",
    });

    ws.close();
  });

  test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:missing",
    });

    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(false);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();

    ws.close();
  });

  test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:worker",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
      | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
      | undefined;
    expect(event).toMatchObject({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      outcome: "deleted",
    });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:worker",
      emitLifecycleHooks: false,
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });
    subagentLifecycleHookState.hasSubagentEndedHook = false;

    const { ws } = await openClient();
    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:subagent:worker",
    });
    expect(deleted.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-delete",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset aborts active runs and clears queues", async () => {
    await seedActiveMainSession();
    const waitCallCountAtSnapshotClear: number[] = [];
    bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
      waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
    });

    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", true);

    const { ws } = await openClient();

    const reset = await rpcReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      ws,
      "sessions.reset",
      {
        key: "main",
      },
    );
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
    expectActiveRunCleanup(
      "agent:main:main",
      ["main", "agent:main:main", "sess-main"],
      "sess-main",
    );
    expect(waitCallCountAtSnapshotClear).toEqual([1]);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: expect.arrayContaining(["main", "agent:main:main", "sess-main"]),
      onWarn: expect.any(Function),
    });
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "agent:main:main",
        targetKind: "acp",
        reason: "session-reset",
        sendFarewell: true,
        outcome: "reset",
      },
      {
        childSessionKey: "agent:main:main",
      },
    );
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset closes ACP runtime handles for ACP sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:reset",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        },
      },
    });
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:main:main",
          backend: "acpx",
          runtimeSessionName: "runtime:reset",
        })),
        runTurn: vi.fn(async function* () {}),
        cancel: vi.fn(async () => {}),
        close: acpRuntimeMocks.close,
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(true);
    expect(acpRuntimeMocks.close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:main:main",
        backend: "acpx",
        runtimeSessionName: "runtime:reset",
      },
      reason: "session-reset",
    });

    ws.close();
  });

  test("sessions.reset does not emit lifecycle events when key does not exist", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      ws,
      "sessions.reset",
      {
        key: "agent:main:subagent:missing",
      },
    );

    expect(reset.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();

    ws.close();
  });

  test("sessions.reset emits subagent targetKind for subagent sessions", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-subagent", "hello");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:worker": {
          sessionId: "sess-subagent",
          updatedAt: Date.now(),
        },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string; entry: { sessionId: string } }>(
      ws,
      "sessions.reset",
      {
        key: "agent:main:subagent:worker",
      },
    );
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:subagent:worker");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-subagent");
    expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
      | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
      | undefined;
    expect(event).toMatchObject({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-reset",
      outcome: "reset",
    });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:worker",
      targetKind: "subagent",
      reason: "session-reset",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset directly unbinds thread bindings when hooks are unavailable", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    subagentLifecycleHookState.hasSubagentEndedHook = false;

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(true);
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
    });

    ws.close();
  });

  test("sessions.reset emits internal command hook with reason", async () => {
    const { dir } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-main", "hello");

    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });

    const { ws } = await openClient();
    const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", {
      key: "main",
      reason: "new",
    });
    expect(reset.ok).toBe(true);
    expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
    const event = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as { context?: { previousSessionEntry?: unknown } } | undefined;
    if (!event) {
      throw new Error("expected session hook event");
    }
    expect(event).toMatchObject({
      type: "command",
      action: "new",
      sessionKey: "agent:main:main",
      context: {
        commandSource: "gateway:sessions.reset",
      },
    });
    expect(event.context?.previousSessionEntry).toMatchObject({ sessionId: "sess-main" });
    ws.close();
  });

  test("sessions.reset returns unavailable when active run does not stop", async () => {
    const { dir, storePath } = await seedActiveMainSession();
    const waitCallCountAtSnapshotClear: number[] = [];
    bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
      waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
    });

    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", false);

    const { ws } = await openClient();

    const reset = await rpcReq(ws, "sessions.reset", {
      key: "main",
    });
    expect(reset.ok).toBe(false);
    expect(reset.error?.code).toBe("UNAVAILABLE");
    expect(reset.error?.message ?? "").toMatch(/still active/i);
    expectActiveRunCleanup(
      "agent:main:main",
      ["main", "agent:main:main", "sess-main"],
      "sess-main",
    );
    expect(waitCallCountAtSnapshotClear).toEqual([1]);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
    const filesAfterResetAttempt = await fs.readdir(dir);
    expect(filesAfterResetAttempt.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(false);

    ws.close();
  });

  test("sessions.delete returns unavailable when active run does not stop", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSingleLineSession(dir, "sess-active", "active");

    await writeSessionStore({
      entries: {
        "discord:group:dev": {
          sessionId: "sess-active",
          updatedAt: Date.now(),
        },
      },
    });

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", false);

    const { ws } = await openClient();

    const deleted = await rpcReq(ws, "sessions.delete", {
      key: "discord:group:dev",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.code).toBe("UNAVAILABLE");
    expect(deleted.error?.message ?? "").toMatch(/still active/i);
    expectActiveRunCleanup(
      "agent:main:discord:group:dev",
      ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
      "sess-active",
    );
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:discord:group:dev"]?.sessionId).toBe("sess-active");
    const filesAfterDeleteAttempt = await fs.readdir(dir);
    expect(filesAfterDeleteAttempt.some((f) => f.startsWith("sess-active.jsonl.deleted."))).toBe(
      false,
    );

    ws.close();
  });

  test("sessions.hygiene cleans an existing session transcript in place", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.2",
          thinkingLevel: "low",
          reasoningLevel: "on",
        },
      },
    });
    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockImplementationOnce(async (params) => {
      await fs.writeFile(
        String((params as { sessionFile?: string }).sessionFile),
        `${JSON.stringify({ role: "assistant", content: "cleaned transcript" })}\n`,
        "utf-8",
      );
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Compacted summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 120,
          tokensAfter: 60,
        },
      };
    });

    const { ws } = await openClient();
    const result = await rpcReq<{
      ok: true;
      sessionKey: string;
      summary?: string;
      continuationSessionKey?: string | null;
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "clean",
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.sessionKey).toBe("agent:main:main");
    expect(result.payload?.summary).toBe("Compacted summary");
    expect(result.payload?.continuationSessionKey).toBeNull();
    const compactCall = sessionHygieneMocks.compactEmbeddedPiSessionDirect.mock.calls[0]?.[0] as
      | {
          sessionKey?: string;
          sessionId?: string;
          sessionFile?: string;
          provider?: string;
          model?: string;
          thinkLevel?: string;
          reasoningLevel?: string;
        }
      | undefined;
    expect(compactCall).toMatchObject({
      sessionKey: "agent:main:main",
      provider: "openai",
      model: "gpt-5.2",
      thinkLevel: "low",
      reasoningLevel: "on",
    });
    expect(compactCall?.sessionId).not.toBe("sess-main");
    expect(compactCall?.sessionFile).toBeDefined();
    expect(compactCall?.sessionFile).not.toBe(transcriptPath);
    const cleanedTranscript = await fs.readFile(transcriptPath, "utf-8");
    expect(cleanedTranscript).toContain("cleaned transcript");

    ws.close();
  });

  test("sessions.hygiene clean mode emits progress updates and uses a bounded working copy for large transcripts", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const lines = Array.from({ length: 22_000 }, (_, index) =>
      JSON.stringify({
        role: "user",
        content: `line ${index} ${"x".repeat(80)}`,
      }),
    ).join("\n");
    await fs.writeFile(transcriptPath, `${lines}\n`, "utf-8");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });

    let workingCopySize = 0;
    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockImplementationOnce(async (params) => {
      const sessionFile = String((params as { sessionFile?: string }).sessionFile);
      workingCopySize = (await fs.stat(sessionFile)).size;
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ role: "assistant", content: "bounded clean result" })}\n`,
        "utf-8",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Compacted summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 120,
          tokensAfter: 60,
        },
      };
    });

    const { ws } = await openClient();
    const preparingProgress = onceMessage<{
      type: "event";
      event: string;
      payload?: { phase?: string; detail?: string | null };
    }>(
      ws,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        msg.payload?.phase === "preparing-working-copy",
    );
    const compactingProgress = onceMessage<{
      type: "event";
      event: string;
      payload?: { phase?: string; detail?: string | null };
    }>(
      ws,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        msg.payload?.phase === "compacting",
    );
    const completedProgress = onceMessage<{
      type: "event";
      event: string;
      payload?: { phase?: string; detail?: string | null; compacted?: boolean | null };
    }>(
      ws,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        msg.payload?.phase === "completed",
    );
    const resultPromise = rpcReq<{
      ok: true;
      compacted: boolean;
      summary?: string;
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "clean",
    });

    const [preparing, compacting, completed, result] = await Promise.all([
      preparingProgress,
      compactingProgress,
      completedProgress,
      resultPromise,
    ]);

    expect(preparing.payload?.phase).toBe("preparing-working-copy");
    expect(compacting.payload?.detail).toBe("Using a bounded working copy for faster cleanup.");
    expect(completed.payload?.compacted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.payload?.compacted).toBe(true);
    expect(workingCopySize).toBeGreaterThan(0);
    expect(workingCopySize).toBeLessThan(900_000);
    const compactCall = sessionHygieneMocks.compactEmbeddedPiSessionDirect.mock.calls[0]?.[0] as
      | { sessionFile?: string }
      | undefined;
    expect(compactCall?.sessionFile).not.toBe(transcriptPath);
    const cleanedTranscript = await fs.readFile(transcriptPath, "utf-8");
    expect(cleanedTranscript).toContain("bounded clean result");

    ws.close();
  });

  test("sessions.hygiene clean mode retries a large bounded working copy against the full transcript when the bounded copy looks empty", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const lines = Array.from({ length: 22_000 }, (_, index) =>
      JSON.stringify({
        role: "user",
        content: `line ${index} ${"x".repeat(80)}`,
      }),
    ).join("\n");
    await fs.writeFile(transcriptPath, `${lines}\n`, "utf-8");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });

    let firstCallSize = 0;
    let secondCallSize = 0;
    sessionHygieneMocks.compactEmbeddedPiSessionDirect
      .mockImplementationOnce(async (params) => {
        const sessionFile = String((params as { sessionFile?: string }).sessionFile);
        firstCallSize = (await fs.stat(sessionFile)).size;
        return {
          ok: true,
          compacted: false,
          reason: "no real conversation messages",
        };
      })
      .mockImplementationOnce(async (params) => {
        const sessionFile = String((params as { sessionFile?: string }).sessionFile);
        secondCallSize = (await fs.stat(sessionFile)).size;
        await fs.writeFile(
          sessionFile,
          `${JSON.stringify({ role: "assistant", content: "cleaned from full fallback" })}\n`,
          "utf-8",
        );
        return {
          ok: true,
          compacted: true,
          result: {
            summary: "Compacted summary",
            firstKeptEntryId: "entry-1",
            tokensBefore: 120,
            tokensAfter: 60,
          },
        };
      });

    const { ws } = await openClient();
    const result = await rpcReq<{
      ok: true;
      compacted: boolean;
      summary?: string;
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "clean",
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.compacted).toBe(true);
    expect(result.payload?.summary).toBe("Compacted summary");
    expect(sessionHygieneMocks.compactEmbeddedPiSessionDirect).toHaveBeenCalledTimes(2);
    expect(firstCallSize).toBeGreaterThan(0);
    expect(firstCallSize).toBeLessThan(900_000);
    expect(secondCallSize).toBeGreaterThan(firstCallSize);
    const cleanedTranscript = await fs.readFile(transcriptPath, "utf-8");
    expect(cleanedTranscript).toContain("cleaned from full fallback");

    ws.close();
  });

  test("sessions.hygiene progress updates target only the requesting connection", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });

    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockImplementationOnce(async (params) => {
      const sessionFile = String((params as { sessionFile?: string }).sessionFile);
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ role: "assistant", content: "clean result" })}\n`,
        "utf-8",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Compacted summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 120,
          tokensAfter: 60,
        },
      };
    });

    const { ws: requesterWs } = await openClient();
    const { ws: observerWs } = await openClient();
    const requesterProgress = onceMessage<{
      type: "event";
      event: string;
      payload?: { phase?: string };
    }>(
      requesterWs,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        msg.payload?.phase === "compacting",
    );
    const observerNoProgress = expectNoMatchingMessage(
      observerWs,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        typeof msg.payload === "object" &&
        msg.payload !== null,
    );

    const resultPromise = rpcReq<{ ok: true; compacted: boolean }>(
      requesterWs,
      "sessions.hygiene",
      {
        sessionKey: "main",
        mode: "clean",
      },
    );

    const [progress, result] = await Promise.all([
      requesterProgress,
      resultPromise,
      observerNoProgress,
    ]);
    expect(progress.payload?.phase).toBe("compacting");
    expect(result.ok).toBe(true);
    expect(result.payload?.compacted).toBe(true);

    requesterWs.close();
    observerWs.close();
  });

  test("sessions.hygiene creates a compacted continuation from a temporary transcript copy", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          label: "Primary Control Room",
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });

    const { ws } = await openClient();
    const result = await rpcReq<{
      ok: true;
      sessionKey: string;
      summary?: string;
      continuationSessionKey?: string | null;
      continuation?: { sessionKey?: string; message?: string };
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "compacted-continuation",
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.sessionKey).toBe("agent:main:main");
    expect(result.payload?.summary).toBe("Compacted summary");
    const continuationSessionKey = result.payload?.continuationSessionKey;
    expect(continuationSessionKey).toMatch(/^agent:main:session-/);
    expect(result.payload?.continuation?.sessionKey).toBe(continuationSessionKey);

    const compactCall = sessionHygieneMocks.compactEmbeddedPiSessionDirect.mock.calls[0]?.[0] as
      | { sessionFile?: string; sessionId?: string }
      | undefined;
    expect(compactCall?.sessionFile).toBeDefined();
    expect(compactCall?.sessionFile).not.toBe(transcriptPath);
    expect(compactCall?.sessionId).not.toBe("sess-main");

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { displayName?: string; sessionFile?: string }
    >;
    expect(continuationSessionKey).toBeTruthy();
    if (!continuationSessionKey) {
      throw new Error("missing continuation session key");
    }
    expect(store[continuationSessionKey]).toMatchObject({
      displayName: "Primary Control Room continuation",
    });
    const continuationFile = store[continuationSessionKey]?.sessionFile;
    expect(continuationFile).toBeTruthy();
    if (!continuationFile) {
      throw new Error("missing continuation transcript path");
    }
    const continuationTranscript = await fs.readFile(continuationFile, "utf-8");
    expect(continuationTranscript).toContain("Compacted summary");

    ws.close();
  });

  test("sessions.hygiene continuation mode emits bounded progress and a seeding stage for large transcripts", async () => {
    const { dir } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const lines = Array.from({ length: 22_000 }, (_, index) =>
      JSON.stringify({
        role: "user",
        content: `line ${index} ${"x".repeat(80)}`,
      }),
    ).join("\n");
    await fs.writeFile(transcriptPath, `${lines}\n`, "utf-8");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          label: "Primary Control Room",
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });

    let workingCopySize = 0;
    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockImplementationOnce(async (params) => {
      const sessionFile = String((params as { sessionFile?: string }).sessionFile);
      workingCopySize = (await fs.stat(sessionFile)).size;
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Compacted summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 120,
          tokensAfter: 60,
        },
      };
    });

    const { ws } = await openClient();
    const compactingProgress = onceMessage<{
      type: "event";
      event: string;
      payload?: {
        phase?: string;
        detail?: string | null;
        step?: number | null;
        totalSteps?: number | null;
      };
    }>(
      ws,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        msg.payload?.phase === "compacting",
    );
    const seedingProgress = onceMessage<{
      type: "event";
      event: string;
      payload?: {
        phase?: string;
        detail?: string | null;
        step?: number | null;
        totalSteps?: number | null;
      };
    }>(
      ws,
      (msg) =>
        msg.type === "event" &&
        msg.event === "session.hygiene" &&
        msg.payload?.phase === "seeding-continuation",
    );
    const resultPromise = rpcReq<{
      ok: true;
      compacted: boolean;
      continuationSessionKey?: string | null;
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "compacted-continuation",
    });

    const [compacting, seeding, result] = await Promise.all([
      compactingProgress,
      seedingProgress,
      resultPromise,
    ]);

    expect(compacting.payload?.detail).toBe(
      "Using a bounded working copy so continuation compaction stays focused on the recent transcript tail.",
    );
    expect(compacting.payload?.step).toBe(4);
    expect(compacting.payload?.totalSteps).toBe(6);
    expect(seeding.payload?.step).toBe(6);
    expect(seeding.payload?.totalSteps).toBe(6);
    expect(seeding.payload?.detail).toContain("bounded working copy");
    expect(result.ok).toBe(true);
    expect(result.payload?.compacted).toBe(true);
    expect(result.payload?.continuationSessionKey).toMatch(/^agent:main:session-/);
    expect(workingCopySize).toBeGreaterThan(0);
    expect(workingCopySize).toBeLessThan(900_000);

    ws.close();
  });

  test("sessions.hygiene continuation mode retries the full transcript before giving up on a bounded no-op", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const lines = Array.from({ length: 22_000 }, (_, index) =>
      JSON.stringify({
        role: "user",
        content: `line ${index} ${"x".repeat(80)}`,
      }),
    ).join("\n");
    await fs.writeFile(transcriptPath, `${lines}\n`, "utf-8");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          label: "Primary Control Room",
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });

    let firstCallSize = 0;
    let secondCallSize = 0;
    sessionHygieneMocks.compactEmbeddedPiSessionDirect
      .mockImplementationOnce(async (params) => {
        const sessionFile = String((params as { sessionFile?: string }).sessionFile);
        firstCallSize = (await fs.stat(sessionFile)).size;
        return {
          ok: true,
          compacted: false,
          reason: "no real conversation messages",
        };
      })
      .mockImplementationOnce(async (params) => {
        const sessionFile = String((params as { sessionFile?: string }).sessionFile);
        secondCallSize = (await fs.stat(sessionFile)).size;
        return {
          ok: true,
          compacted: true,
          result: {
            summary: "Compacted summary",
            firstKeptEntryId: "entry-1",
            tokensBefore: 120,
            tokensAfter: 60,
          },
        };
      });

    const { ws } = await openClient();
    const result = await rpcReq<{
      ok: true;
      compacted: boolean;
      continuationSessionKey?: string | null;
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "compacted-continuation",
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.compacted).toBe(true);
    expect(result.payload?.continuationSessionKey).toMatch(/^agent:main:session-/);
    expect(sessionHygieneMocks.compactEmbeddedPiSessionDirect).toHaveBeenCalledTimes(2);
    expect(firstCallSize).toBeGreaterThan(0);
    expect(firstCallSize).toBeLessThan(900_000);
    expect(secondCallSize).toBeGreaterThan(firstCallSize);

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionFile?: string }
    >;
    const continuationSessionKey = result.payload?.continuationSessionKey;
    expect(continuationSessionKey).toBeTruthy();
    if (!continuationSessionKey) {
      throw new Error("missing continuation session key");
    }
    const continuationTranscript = await fs.readFile(
      String(store[continuationSessionKey]?.sessionFile),
      "utf-8",
    );
    expect(continuationTranscript).toContain("Compacted summary");

    ws.close();
  });

  test("sessions.hygiene returns a no-op response when compacted continuation is not needed", async () => {
    const { dir, storePath } = await createSessionStoreDir();
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf-8",
    );
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
          label: "Primary Control Room",
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      },
    });
    sessionHygieneMocks.compactEmbeddedPiSessionDirect.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 120,
        tokensAfter: 120,
      },
    });

    const { ws } = await openClient();
    const result = await rpcReq<{
      ok: true;
      compacted: boolean;
      sessionKey: string;
      summary?: string;
      detail?: string | null;
      continuationSessionKey?: string | null;
      continuation?: { sessionKey?: string; message?: string };
    }>(ws, "sessions.hygiene", {
      sessionKey: "main",
      mode: "compacted-continuation",
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.sessionKey).toBe("agent:main:main");
    expect(result.payload?.compacted).toBe(false);
    expect(result.payload?.summary).toContain("No compaction needed:");
    expect(result.payload?.summary).toContain("120 estimated history tokens");
    expect(result.payload?.summary).toContain("compaction budget");
    expect(result.payload?.detail).toContain("120 <=");
    expect(result.payload?.continuationSessionKey).toBeNull();
    expect(result.payload?.continuation).toBeUndefined();

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(store)).toEqual(["agent:main:main"]);

    ws.close();
  });

  test("webchat clients cannot patch or delete sessions", async () => {
    await createSessionStoreDir();

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      scopes: ["operator.admin"],
    });

    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "should-fail",
    });
    expect(patched.ok).toBe(false);
    expect(patched.error?.message ?? "").toMatch(/webchat clients cannot patch sessions/i);

    const deleted = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.message ?? "").toMatch(/webchat clients cannot delete sessions/i);

    ws.close();
  });

  test("control-ui client can delete sessions even in webchat mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-control-ui-delete-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-group",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`, {
      headers: { origin: `http://127.0.0.1:${harness.port}` },
    });
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => ws.once("open", resolve));
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes: ["operator.admin"],
    });

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
      key: "agent:main:discord:group:dev",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);

    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(store["agent:main:discord:group:dev"]).toBeUndefined();

    ws.close();
  });
});
