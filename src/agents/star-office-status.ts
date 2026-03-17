import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TEAM_ROLES = new Set(["main", "coder", "ops"]);
const runStateCache = new Map<string, string>();

export type StarOfficeContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
};

export type StarOfficeState =
  | "idle"
  | "writing"
  | "researching"
  | "executing"
  | "syncing"
  | "error";

function resolveRole(ctx: StarOfficeContext): "main" | "coder" | "ops" | null {
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  if (TEAM_ROLES.has(agentId)) {
    return agentId as "main" | "coder" | "ops";
  }

  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const match = /^agent:(main|coder|ops)(?::|$)/.exec(sessionKey);
  if (match?.[1] && TEAM_ROLES.has(match[1])) {
    return match[1] as "main" | "coder" | "ops";
  }

  return null;
}

function resolveRunCacheKey(ctx: StarOfficeContext, role: string): string {
  return ctx.runId || ctx.sessionId || ctx.sessionKey || role;
}

function resolveWorkflowScript(workspaceDir?: string): string | null {
  const root =
    typeof workspaceDir === "string" && workspaceDir.trim()
      ? workspaceDir.trim()
      : typeof process.env.OPENCLAW_WORKSPACE_DIR === "string"
        ? process.env.OPENCLAW_WORKSPACE_DIR.trim()
        : "";
  if (!root) {
    return null;
  }
  const candidate = path.resolve(root, "Star-Office-UI", "scripts", "team-workflow.py");
  return fs.existsSync(candidate) ? candidate : null;
}

function normalizeDetail(detail: string | undefined, fallback: string): string {
  const normalized = typeof detail === "string" ? detail.replace(/\s+/g, " ").trim() : "";
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function inferRunState(role: "main" | "coder" | "ops", prompt: string): StarOfficeState {
  const text = prompt.toLowerCase();
  if (/(deploy|release|publish|push|sync|handoff|merge|ship)/.test(text)) {
    return "syncing";
  }
  if (/(error|bug|fix|debug|investigate|排查|修复|报错|异常)/.test(text)) {
    return role === "ops" ? "executing" : "researching";
  }
  if (/(write|draft|edit|implement|refactor|code|patch|文档|写|实现|编码)/.test(text)) {
    return "writing";
  }
  if (
    /(run|exec|command|test|check|verify|inspect|restart|build|执行|运行|测试|检查|验证)/.test(text)
  ) {
    return "executing";
  }
  return "researching";
}

function inferToolState(toolName: string, params: Record<string, unknown>): StarOfficeState | null {
  const name = toolName.trim().toLowerCase();
  if (["read", "web_search", "web_fetch", "image", "pdf"].includes(name)) {
    return "researching";
  }
  if (["write", "edit"].includes(name)) {
    return "writing";
  }
  if (["exec", "process", "canvas"].includes(name)) {
    return "executing";
  }
  if (name === "browser") {
    const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
    if (["snapshot", "screenshot", "open", "tabs", "status", "pdf"].includes(action)) {
      return "researching";
    }
    return "executing";
  }
  if (name === "message") {
    const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
    return action === "send" || action === "broadcast" ? "syncing" : null;
  }
  return null;
}

function stateToWorkflowStage(
  state: StarOfficeState,
): "start" | "write" | "run" | "sync" | "fail" | "done" {
  switch (state) {
    case "writing":
      return "write";
    case "executing":
      return "run";
    case "syncing":
      return "sync";
    case "error":
      return "fail";
    case "idle":
      return "done";
    case "researching":
    default:
      return "start";
  }
}

function spawnWorkflow(
  scriptPath: string,
  role: "main" | "coder" | "ops",
  state: StarOfficeState,
  detail: string,
): void {
  const stage = stateToWorkflowStage(state);
  const child = spawn("python3", [scriptPath, stage, role, detail], {
    cwd: path.dirname(scriptPath),
    env: process.env,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort only — never break the agent run on office sync failures.
  });
  child.unref();
}

function pushState(ctx: StarOfficeContext, state: StarOfficeState, detail: string): void {
  const role = resolveRole(ctx);
  if (!role) {
    return;
  }
  const scriptPath = resolveWorkflowScript(ctx.workspaceDir);
  if (!scriptPath) {
    return;
  }
  const cacheKey = resolveRunCacheKey(ctx, role);
  const dedupeKey = `${state}::${detail}`;
  if (runStateCache.get(cacheKey) === dedupeKey) {
    return;
  }
  runStateCache.set(cacheKey, dedupeKey);
  spawnWorkflow(scriptPath, role, state, detail);
  if (state === "idle") {
    runStateCache.delete(cacheKey);
  }
}

export function syncStarOfficeRunStart(ctx: StarOfficeContext, prompt: string): void {
  const role = resolveRole(ctx);
  if (!role) {
    return;
  }
  const state = inferRunState(role, prompt);
  pushState(ctx, state, normalizeDetail(prompt, `${role} started work`));
}

export function syncStarOfficeToolStart(
  ctx: StarOfficeContext,
  toolName: string,
  params: Record<string, unknown>,
): void {
  const state = inferToolState(toolName, params);
  if (!state) {
    return;
  }
  const detailBase = (() => {
    if (toolName === "exec" && typeof params.command === "string") {
      return params.command;
    }
    if (toolName === "read") {
      const maybePath =
        typeof params.path === "string"
          ? params.path
          : typeof params.file_path === "string"
            ? params.file_path
            : "";
      return maybePath || `using ${toolName}`;
    }
    return `using ${toolName}`;
  })();
  pushState(ctx, state, normalizeDetail(detailBase, `using ${toolName}`));
}

export function syncStarOfficeToolError(
  ctx: StarOfficeContext,
  toolName: string,
  error: string,
): void {
  pushState(ctx, "error", normalizeDetail(error, `${toolName} failed`));
}

export function syncStarOfficeRunEnd(
  ctx: StarOfficeContext,
  success: boolean,
  error?: string,
): void {
  if (!success) {
    pushState(ctx, "error", normalizeDetail(error, "agent run failed"));
    return;
  }
  pushState(ctx, "idle", "ready");
}
