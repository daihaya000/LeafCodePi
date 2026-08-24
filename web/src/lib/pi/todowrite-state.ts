import type { TodoDto, TodoPriority, TodoProgressDto, TodoStatus } from "@/lib/types";

const MAX_TODOS = 100;
const MAX_CONTENT_CHARS = 2_000;

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low";
}

function normalizeTodos(value: unknown): TodoDto[] {
  if (!Array.isArray(value) || value.length > MAX_TODOS) return [];
  return value.flatMap((item, index) => {
    const raw = asRecord(item);
    const content = typeof raw?.content === "string" ? raw.content.trim() : "";
    if (
      !content ||
      content.length > MAX_CONTENT_CHARS ||
      !isTodoStatus(raw?.status) ||
      !isTodoPriority(raw?.priority)
    ) {
      return [];
    }
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 120) : `todo-${index + 1}`;
    return [{ id, content, status: raw.status, priority: raw.priority }];
  });
}

export function todoProgressFromTodos(todos: readonly TodoDto[]): TodoProgressDto | undefined {
  if (todos.length === 0) return undefined;
  return {
    completed: todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled").length,
    total: todos.length,
  };
}

/** Return the latest persisted todowrite snapshot from the current Pi branch. */
export function todosFromPiMessages(messages: readonly unknown[]): TodoDto[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "toolResult" || message.toolName !== "todowrite") continue;
    const details = asRecord(message.details);
    if (!details || !Array.isArray(details.todos)) return [];
    return normalizeTodos(details.todos);
  }
  return [];
}
