import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  LEAFCODE_STRICT_BLOCKED_TOOL_NAMES,
  type LeafCodeCollaborationMode,
} from "./contract.ts";
import { readCollaborationConfig } from "./config.ts";

export * from "./contract.ts";
export * from "./config.ts";

type RuntimeState = {
  mode: LeafCodeCollaborationMode;
  configValid: boolean;
  configError?: string;
};

const runtimeStates = new WeakMap<ExtensionContext, RuntimeState>();
const POLICY = [
  "This is a shared LeafCodePi checkout.",
  'Call leafcode_collab({ action: "status" }) before editing.',
  "Standard write, edit, and bash tools are unavailable in strict mode.",
  "Use the leafcode_* tools; mutation, checks, and commits remain disabled until their coordinator is ready.",
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
  throw new Error(`${toolName} is disabled during Phase 0; the collaboration coordinator is not ready.`);
}

function statusResult(ctx: ExtensionContext): AgentToolResult<Record<string, unknown>> {
  const state = runtimeState(ctx);
  return {
    content: [{ type: "text", text: `LeafCode collaboration Phase 0 (${state.mode}); coordinator not ready.` }],
    details: {
      phase: 0,
      ready: false,
      mode: state.mode,
      configValid: state.configValid,
      ...(state.configError ? { configError: state.configError } : {}),
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const state = runtimeState(ctx);
    if (!state.configValid && ctx.hasUI) {
      ctx.ui.notify(`LeafCode collaboration config is invalid; strict mode enforced (${state.configError ?? "unknown error"}).`, "warning");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (runtimeState(ctx).mode !== "strict") return undefined;
    return { systemPrompt: POLICY };
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = runtimeState(ctx);
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

  pi.registerTool({
    name: "leafcode_collab",
    label: "LeafCode Collaboration",
    description: "Show the LeafCode collaboration boundary status.",
    promptSnippet: "Inspect LeafCode collaboration status",
    parameters: Type.Object({ action: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action !== undefined && params.action !== "status") {
        throw new Error('Phase 0 only supports leafcode_collab({ action: "status" }).');
      }
      return statusResult(ctx);
    },
  });

  pi.registerTool({
    name: "leafcode_write",
    label: "LeafCode Write",
    description: "Write an owned LeafCode path after lease validation (Phase 1).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute() {
      return unavailable("leafcode_write");
    },
  });

  pi.registerTool({
    name: "leafcode_edit",
    label: "LeafCode Edit",
    description: "Edit an owned LeafCode path after lease validation (Phase 1).",
    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
    async execute() {
      return unavailable("leafcode_edit");
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
