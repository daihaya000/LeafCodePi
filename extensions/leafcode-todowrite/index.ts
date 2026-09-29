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
import { hasJevNoulJudge } from "./jev-bridge.ts";
import { normalizeTodos, type TodoItem } from "./state.ts";
import { clipRequestText, judgeTodoNotNeeded } from "./todo-need.ts";
export { normalizeTodos } from "./state.ts";
export type { TodoItem, TodoPriority, TodoStatus } from "./state.ts";

export type TodoDetails = {
  todos: TodoItem[];
  updatedAt: string;
  error?: string;
};

const MAX_TODOS = 100;
const TODO_GATE_READ_LIMIT = 3;
const TODO_GATE_REASON =
  "ToDoが未起票です。作業前に todowrite で項目を1件以上登録し、着手項目を in_progress にしてください。";
// Delivered once per task at settlement. Wording stays task-agnostic so a
// follow-up that lands on the next prompt cannot misdescribe the new task.
const TODO_GATE_MESSAGE = [
  "ToDo未起票のまま作業しようとしていました。",
  "todowrite で項目を登録し、1件を in_progress に保ち、完了した手順から completed にしてください。",
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
  "intercom",
  "jev_judge",
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
  violationObserved: boolean;
  reminderSent: boolean;
  /** The user's request for this task (clipped). Empty when the start of the task is unknown. */
  requestText: string;
  /** Jev judged the task too small for a ToDo list, so the gate stays open until the task ends. */
  waived: boolean;
  /** The Jev consultation of this task. Shared by every call the gate stops, asked at most once. */
  waiver: Promise<boolean> | undefined;
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

function createTodoGateState(): TodoGateState {
  return {
    openedThisTask: false,
    substantiveCalls: 0,
    violationObserved: false,
    reminderSent: false,
    requestText: "",
    waived: false,
    waiver: undefined,
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

/** Asks Jev once per task. A clear "no" opens the gate for the rest of the task. Never rejects. */
function consultJev(task: TodoGateState, signal: AbortSignal | undefined): Promise<void> {
  if (!task.waiver) {
    const waiver: Promise<boolean> = judgeTodoNotNeeded({ requestText: task.requestText, signal })
      .catch(() => false)
      .then((waive) => {
        // A steer / followUp may have replaced this consultation while it was in flight.
        if (waive && task.waiver === waiver) task.waived = true;
        return waive;
      });
    task.waiver = waiver;
  }
  return task.waiver.then(() => undefined);
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

  const resetGate = () => {
    gate = createTodoGateState();
  };
  const gateEnabled = () => pi.getActiveTools().includes("todowrite");
  const restore = (ctx: ExtensionContext) => {
    todos = reconstructState(ctx);
    resetGate();
    // A resumed or reloaded session can already hold an active list. Requiring
    // an identical todowrite again would only add friction, so the gate stays
    // open while an in_progress item exists.
    if (todos.some((todo) => todo.status === "in_progress")) gate.openedThisTask = true;
    updateTui(ctx, todos);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    const text = typeof event.text === "string" ? event.text : "";
    if (event.streamingBehavior === undefined) {
      resetGate();
      gate.requestText = clipRequestText(text);
      return;
    }
    // steer / followUp continue the task, but added instructions can make it bigger.
    // Forget an earlier Jev verdict so the next stop is judged with them. When the start
    // of the task is unknown, the added text alone would be a misleading request.
    if (!gate.requestText) return;
    gate.requestText = clipRequestText(`${gate.requestText}\n\n${text}`);
    gate.waived = false;
    gate.waiver = undefined;
  });
  pi.on("tool_call", (event, ctx) => {
    const task = gate;
    if (task.openedThisTask || task.waived) return;
    const action = classifyToolForTodoGate(event.toolName, event.input);
    if (action === "allow" || !gateEnabled()) return;
    if (action === "count") {
      task.substantiveCalls += 1;
      if (task.substantiveCalls < TODO_GATE_READ_LIMIT) return;
    }
    // Gate operations, not words in the prompt.
    const stop = () => {
      if (task.openedThisTask || task.waived) return undefined;
      task.violationObserved = true;
      return { block: true, reason: TODO_GATE_REASON };
    };
    // Without Jev (no host, or an unknown request) this is the conventional synchronous
    // stop. Otherwise Jev is asked once whether the task needs a ToDo list at all.
    if (!task.requestText || !hasJevNoulJudge()) return stop();
    return consultJev(task, ctx.signal).then(stop);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (
      gate.openedThisTask ||
      !gate.violationObserved ||
      gate.reminderSent ||
      !gateEnabled()
    ) return;

    try {
      pi.sendMessage(
        {
          customType: "leafcode-todowrite-gate",
          content: TODO_GATE_MESSAGE,
          display: false,
        },
        // Never start a turn from agent_settled: the reminder must not act as
        // the resumed work. One reminder per task keeps it from nagging.
        { triggerTurn: false, deliverAs: "followUp" },
      );
      gate.reminderSent = true;
      if (ctx.hasUI) ctx.ui.notify("ToDoを起票してから作業を再開してください。", "warning");
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
      "Keep a todowrite list for work that takes several dependent steps (changing code, files or configuration, running commands with side effects, verifying, committing, delegating). For such work, call todowrite with a non-empty list and mark the current item in_progress before the first edit, shell command, delegation, unclassified tool, or third substantive read-only tool call. For explicit Todo requests, call it before the first substantive tool. When unsure, register.",
      "Update the list at every step: mark the finished item completed and set the next item in_progress when you start it. Never batch status changes to the end of the task.",
      "Skip the list for a question, explanation, single lookup, discussion, standalone judgment call, control-tool use, or one small self-contained action. If the ToDo gate stops a tool call anyway, register the list and retry the call.",
    ],
    // The gate opens from execute(); serialize this tool so a same-batch edit
    // cannot be preflighted before todowrite has recorded its result.
    executionMode: "sequential",
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
