import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  LEAFCODE_STRICT_BLOCKED_TOOL_NAMES,
  type LeafCodeCollaborationMode,
} from "./contract.ts";
import { readCollaborationConfig } from "./config.ts";
import { connectRoom, roomDegradedStatus, type PresenceUpdate, type RoomClient } from "./room.ts";

export * from "./contract.ts";
export * from "./config.ts";

type RuntimeState = {
  mode: LeafCodeCollaborationMode;
  configValid: boolean;
  configError?: string;
  client?: RoomClient;
  connectError?: string;
};

const runtimeStates = new WeakMap<ExtensionContext, RuntimeState>();
const POLICY = [
  "This is a shared LeafCodePi checkout.",
  'Call leafcode_collab({ action: "status" }) before editing.',
  "Standard write, edit, and bash tools are unavailable in strict mode.",
  "Use the leafcode_* tools; checks and commits remain disabled until their fixed gates are ready.",
  "Do not request worktree isolation. If a lease or commit is blocked, report the conflict instead of bypassing it.",
].join("\n");

function runtimeState(ctx: ExtensionContext): RuntimeState {
  const existing = runtimeStates.get(ctx);
  if (existing) return existing;
  const loaded = readCollaborationConfig();
  const state = {
    mode: loaded.config.mode,
    configValid: loaded.valid,
    ...(loaded.error ? { configError: loaded.error } : {}),
  } satisfies RuntimeState;
  runtimeStates.set(ctx, state);
  return state;
}

function strictToolBlocked(toolName: string, mode: LeafCodeCollaborationMode): boolean {
  return mode === "strict" && (LEAFCODE_STRICT_BLOCKED_TOOL_NAMES as readonly string[]).includes(toolName);
}

function requestsWorktree(input: Record<string, unknown>): boolean {
  if (input.worktree === true || input.isolation === "worktree") return true;
  const script = typeof input.workflowScript === "string" ? input.workflowScript : "";
  // Inline workflow code can construct worktree options dynamically; do not
  // attempt an incomplete parser at this trust boundary.
  return script.trim().length > 0;
}

function unavailable(toolName: string): never {
  throw new Error(`${toolName} is disabled during Phase 2; the fixed check/commit gate is not ready.`);
}

function result(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

function sessionInfo(ctx: ExtensionContext): { sessionId: string; displayName: string; pid: number } {
  let displayName = "LeafCode session";
  try {
    displayName = ctx.sessionManager.getSessionName() || displayName;
  } catch {
    // Session metadata is optional in headless contexts.
  }
  return { sessionId: ctx.sessionManager.getSessionId(), displayName, pid: process.pid };
}

async function connectRuntime(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  if (state.client) await state.client.close();
  state.client = undefined;
  state.connectError = undefined;
  try {
    state.client = await connectRoom(ctx.cwd, sessionInfo(ctx));
  } catch (error) {
    state.connectError = error instanceof Error ? error.message : String(error);
  }
}

async function statusResult(ctx: ExtensionContext): Promise<AgentToolResult<Record<string, unknown>>> {
  const state = runtimeState(ctx);
  const base: Record<string, unknown> = {
    phase: 1,
    mode: state.mode,
    configValid: state.configValid,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    ...(state.configError ? { configError: state.configError } : {}),
    ...(state.connectError ? { connectError: state.connectError } : {}),
  };
  if (!state.client) {
    return result(`LeafCode collaboration Phase 1 (${state.mode}); room unavailable.`, {
      ...base,
      ready: false,
      degraded: true,
      reason: state.connectError ?? "Session has not joined the room.",
    });
  }
  const room = roomDegradedStatus(state.client);
  if (!state.client.ready) {
    return result(`LeafCode collaboration Phase 1 (${state.mode}); degraded read-only.`, { ...base, ...room });
  }
  try {
    const current = await state.client.snapshot();
    return result(`LeafCode collaboration Phase 1 (${state.mode}); coordinator ready.`, {
      ...base,
      ...room,
      ready: true,
      degraded: false,
      snapshot: current,
    });
  } catch (error) {
    return result(`LeafCode collaboration Phase 1 (${state.mode}); coordinator unavailable.`, {
      ...base,
      ...room,
      ready: false,
      degraded: true,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireRoom(ctx: ExtensionContext): RoomClient {
  const client = runtimeState(ctx).client;
  if (!client?.ready) throw new Error("LeafCode room is unavailable; mutation and lease operations are disabled.");
  return client;
}

function currentPaths(input: Record<string, unknown>): string[] {
  return typeof input.path === "string" ? [input.path] : [];
}

function updatePresence(ctx: ExtensionContext, update: PresenceUpdate): void {
  const client = runtimeState(ctx).client;
  if (client?.ready) void client.updatePresence(update).catch(() => undefined);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const state = runtimeState(ctx);
    await connectRuntime(ctx, state);
    if (!state.configValid && ctx.hasUI) {
      ctx.ui.notify(`LeafCode collaboration config is invalid; strict mode enforced (${state.configError ?? "unknown error"}).`, "warning");
    }
    if (state.client && !state.client.ready && ctx.hasUI) {
      ctx.ui.notify(`LeafCode collaboration is degraded read-only: ${state.client.degradedReason ?? "room unavailable"}`, "warning");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    updatePresence(ctx, { state: "active", progress: true });
    if (runtimeState(ctx).mode !== "strict") return undefined;
    return { systemPrompt: POLICY };
  });

  pi.on("agent_start", async (_event, ctx) => {
    updatePresence(ctx, { state: "active", progress: true });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    updatePresence(ctx, { state: "idle", currentTool: null, currentPaths: [], progress: true });
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = runtimeState(ctx);
    updatePresence(ctx, { state: "active", currentTool: event.toolName, currentPaths: currentPaths(event.input), progress: true });
    if (strictToolBlocked(event.toolName, state.mode)) {
      return {
        block: true,
        reason: `Standard ${event.toolName} is unavailable in LeafCode collaboration strict mode; use the leafcode_* tools.`,
      };
    }
    if (event.toolName === "subagent" && state.mode === "strict" && requestsWorktree(event.input)) {
      return {
        block: true,
        reason: "Worktree isolation and unverified workflow scripts are unavailable in LeafCode collaboration strict mode.",
      };
    }
    return undefined;
  });

  pi.on("tool_result", async (_event, ctx) => {
    updatePresence(ctx, { state: "idle", currentTool: null, currentPaths: [], progress: true });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const state = runtimeStates.get(ctx);
    if (!state) return;
    await state.client?.close();
    runtimeStates.delete(ctx);
  });

  pi.registerTool({
    name: "leafcode_collab",
    label: "LeafCode Collaboration",
    description: "Inspect the shared room, claim a task, or reserve/release owned paths.",
    promptSnippet: "Inspect LeafCode collaboration status and reserve owned paths",
    parameters: Type.Object({
      action: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      goal: Type.Optional(Type.String()),
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
      leaseId: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "status";
      if (action === "status") return statusResult(ctx);
      const client = requireRoom(ctx);
      if (action === "list" || action === "feed") {
        const current = await client.snapshot();
        const details = action === "list"
          ? { phase: 1, ready: true, sessions: current.sessions, tasks: current.tasks, leases: current.leases, epoch: current.epoch }
          : { phase: 1, ready: true, activity: current.activity, seq: current.seq, epoch: current.epoch };
        return result(`LeafCode ${action}: coordinator ready.`, details);
      }
      if (action === "claim") {
        if (!params.title) throw new Error("leafcode_collab claim requires title.");
        const task = await client.claim({
          title: params.title,
          ...(params.goal ? { goal: params.goal } : {}),
          ...(params.taskId ? { taskId: params.taskId } : {}),
        });
        return result(`Claimed task '${task.title}'.`, { phase: 1, ready: true, task });
      }
      if (action === "reserve") {
        if (!params.paths?.length) throw new Error("leafcode_collab reserve requires paths.");
        const lease = await client.reserve(params.paths);
        return result(`Reserved ${lease.selectors.join(", ")}.`, { phase: 1, ready: true, lease });
      }
      if (action === "release") {
        if (!params.leaseId) throw new Error("leafcode_collab release requires leaseId.");
        const lease = await client.release(params.leaseId);
        return result(`Released lease ${lease.id}.`, { phase: 1, ready: true, lease });
      }
      if (action === "away" || action === "return") {
        await client.updatePresence({ state: action === "away" ? "away" : "active", progress: true });
        return statusResult(ctx);
      }
      throw new Error(`leafcode_collab action '${action}' is not available in Phase 1.`);
    },
  });

  pi.registerTool({
    name: "leafcode_write",
    label: "LeafCode Write",
    description: "Write an owned LeafCode path after lease validation (Phase 1).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const value = await requireRoom(ctx).write(params.path, params.content);
      return result(`Wrote ${params.path}.`, { phase: 1, ready: true, mutation: value });
    },
  });

  pi.registerTool({
    name: "leafcode_edit",
    label: "LeafCode Edit",
    description: "Edit an owned LeafCode path after lease validation (Phase 1).",
    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const value = await requireRoom(ctx).edit(params.path, params.oldText, params.newText);
      return result(`Edited ${params.path}.`, { phase: 1, ready: true, mutation: value });
    },
  });

  pi.registerTool({
    name: "leafcode_check",
    label: "LeafCode Check",
    description: "Run a fixed LeafCode check registry entry (Phase 2).",
    parameters: Type.Object({ checkId: Type.String() }),
    async execute() {
      return unavailable("leafcode_check");
    },
  });

  pi.registerTool({
    name: "leafcode_commit",
    label: "LeafCode Commit",
    description: "Commit only explicitly owned paths through the LeafCode transaction (Phase 2).",
    parameters: Type.Object({ message: Type.String(), paths: Type.Array(Type.String()) }),
    async execute() {
      return unavailable("leafcode_commit");
    },
  });

}
