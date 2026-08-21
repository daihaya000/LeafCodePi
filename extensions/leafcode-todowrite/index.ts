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

  const restore = (ctx: ExtensionContext) => {
    todos = reconstructState(ctx);
    updateTui(ctx, todos);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: "todowrite",
    label: "ToDo",
    description:
      "Replace the current Todo list. Use statuses pending, in_progress, completed, cancelled and priorities high, medium, low. Keep at most one item in_progress.",
    promptSnippet: "Maintain the task Todo list with statuses and priorities",
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

export const todowriteTestSeams = { normalizeTodos };
