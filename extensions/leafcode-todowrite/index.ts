/**
 * OpenCode todowrite-compatible Todo tool for Pi.
 *
 * The complete list is written on every call, matching the skill contract:
 * pending / in_progress / completed / cancelled plus high / medium / low.
 * Tool-result details are the source of truth so Pi session branches retain
 * the correct list after resume or fork.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeTodos, type TodoItem } from "./state.ts";
export { normalizeTodos } from "./state.ts";
export type { TodoItem, TodoPriority, TodoStatus } from "./state.ts";

export type TodoDetails = {
  todos: TodoItem[];
  updatedAt: string;
  error?: string;
};

const MAX_TODOS = 100;
const TODO_GATE_READ_LIMIT = 3;
const IMMEDIATE_TODO_PATTERN = /\b(?:todo|todowrite)\b|ToDo管理|タスク管理|進捗管理|todo実態/iu;
const TODO_GATE_REASON =
  "ToDo required: call todowrite with a non-empty list and mark the current item in_progress before retrying this tool.";
const TODO_GATE_MESSAGE = [
  "ToDo gate: this task attempted work that requires a Todo list, but no non-empty todowrite call was recorded.",
  "Call todowrite now, mark the current item in_progress, then resume the blocked operation.",
].join("\n");

const EXEMPT_TOOLS = new Set([
  "todowrite",
  "question",
  "tool_search",
  "memory_search",
  "session_search",
  "structured_output",
  "task_mutation_decision",
  "watchdog_permission_decision",
  "watchdog_warn",
  "contact_supervisor",
  "subagent_wait",
]);
const SUBSTANTIVE_READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
]);
type TodoGateState = {
  openedThisTask: boolean;
  substantiveCalls: number;
  requiresImmediateTodo: boolean;
  violationObserved: boolean;
  reminderSent: boolean;
};

type TodoGateAction = "allow" | "count" | "block";

const TodoParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      id: Type.Optional(Type.String()),
      content: Type.String(),
      status: StringEnum(["pending", "in_progress", "completed", "cancelled"] as const),
      priority: StringEnum(["high", "medium", "low"] as const),
    }),
    { maxItems: MAX_TODOS },
  ),
});

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function createTodoGateState(prompt = ""): TodoGateState {
  return {
    openedThisTask: false,
    substantiveCalls: 0,
    requiresImmediateTodo: IMMEDIATE_TODO_PATTERN.test(prompt),
    violationObserved: false,
    reminderSent: false,
  };
}

function isPolicyPreflightRead(toolName: string, input: unknown): boolean {
  if (toolName !== "read") return false;
  const path = asRecord(input)?.path;
  if (typeof path !== "string") return false;
  const basename = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()?.toLowerCase();
  return basename === "agents.md" || basename === "skill.md";
}

function classifyToolForTodoGate(toolName: string, input: unknown): TodoGateAction {
  if (isPolicyPreflightRead(toolName, input) || EXEMPT_TOOLS.has(toolName)) return "allow";
  if (toolName === "skill_manage") {
    return asRecord(input)?.action === "view" ? "allow" : "block";
  }
  return SUBSTANTIVE_READ_TOOLS.has(toolName) ? "count" : "block";
}

function doneCount(todos: readonly TodoItem[]): number {
  return todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length;
}

function todoSummary(todos: readonly TodoItem[]): string {
  return `ToDo ${doneCount(todos)}/${todos.length}`;
}

function updateTui(ctx: ExtensionContext, todos: readonly TodoItem[]): void {
  try {
    if (todos.length === 0) {
      ctx.ui.setStatus("todowrite", undefined);
      ctx.ui.setWidget("todowrite", undefined);
      return;
    }
    ctx.ui.setStatus("todowrite", todoSummary(todos));
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      "todowrite",
      todos.length
        ? [
            todoSummary(todos),
            ...todos.slice(0, 8).map((todo) =>
              `${todo.status === "completed" ? "✓" : todo.status === "cancelled" ? "−" : todo.status === "in_progress" ? "▶" : "○"} ${todo.content}`,
            ),
          ]
        : undefined,
    );
  } catch {
    // Headless/RPC contexts may not expose a TUI.
  }
}

function reconstructState(ctx: ExtensionContext): TodoItem[] {
  let current: TodoItem[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "todowrite") continue;
    const details = asRecord(message.details);
    const normalized = normalizeTodos(details?.todos);
    if (!normalized.error) current = normalized.todos;
  }
  return current;
}

export default function (pi: ExtensionAPI): void {
  let todos: TodoItem[] = [];
  let gate = createTodoGateState();

  const resetGate = (prompt = "") => {
    gate = createTodoGateState(prompt);
  };
  const gateEnabled = () => pi.getActiveTools().includes("todowrite");
  const restore = (ctx: ExtensionContext) => {
    todos = reconstructState(ctx);
    resetGate();
    updateTui(ctx, todos);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("input", (event) => {
    if (event.source !== "extension" && event.streamingBehavior === undefined) resetGate(event.text);
  });
  pi.on("tool_call", (event) => {
    if (gate.openedThisTask || !gateEnabled()) return;
    const action = classifyToolForTodoGate(event.toolName, event.input);
    if (action === "allow") return;
    if (action === "count") {
      gate.substantiveCalls += 1;
      if (!gate.requiresImmediateTodo && gate.substantiveCalls < TODO_GATE_READ_LIMIT) return;
    }
    gate.violationObserved = true;
    return { block: true, reason: TODO_GATE_REASON };
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (
      gate.openedThisTask ||
      !gate.violationObserved ||
      gate.reminderSent ||
      !gateEnabled()
    ) return;

    // Set before enqueueing because sendMessage is non-idempotent.
    gate.reminderSent = true;
    try {
      pi.sendMessage(
        {
          customType: "leafcode-todowrite-gate",
          content: TODO_GATE_MESSAGE,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      if (ctx.hasUI) ctx.ui.notify("ToDoを起票してから作業を再開します。", "warning");
    } catch (error) {
      console.error("Failed to enqueue the ToDo gate reminder:", error);
    }
  });

  pi.registerTool({
    name: "todowrite",
    label: "ToDo",
    description:
      "Replace the current Todo list. Use statuses pending, in_progress, completed, cancelled and priorities high, medium, low. Keep at most one item in_progress.",
    promptSnippet: "Maintain the task Todo list with statuses and priorities",
    promptGuidelines: [
      "Call todowrite with a non-empty list and mark the current item in_progress before edits, shell commands, delegation, or the third substantive read-only tool call. For explicit Todo requests, call it before the first substantive tool.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const normalized = normalizeTodos(params.todos, todos);
      if (normalized.error) {
        return {
          content: [{ type: "text", text: normalized.error }],
          details: {
            todos: [...todos],
            updatedAt: new Date().toISOString(),
            error: normalized.error,
          } satisfies TodoDetails,
        };
      }
      todos = normalized.todos;
      if (todos.some((todo) => todo.status === "in_progress")) gate.openedThisTask = true;
      const details = {
        todos: [...todos],
        updatedAt: new Date().toISOString(),
      } satisfies TodoDetails;
      updateTui(ctx, todos);
      return {
        content: [{ type: "text", text: `${todoSummary(todos)} を更新しました。` }],
        details,
      };
    },
  });

  pi.registerCommand("todos", {
    description: "現在のToDo一覧を表示",
    handler: async (_args, ctx) => {
      const text = todos.length
        ? [todoSummary(todos), ...todos.map((todo) => `${todo.status} [${todo.priority}] ${todo.content}`)].join("\n")
        : "ToDo はありません。";
      ctx.ui.notify(text, "info");
    },
  });
}

export const todowriteTestSeams = { isPolicyPreflightRead, normalizeTodos };
