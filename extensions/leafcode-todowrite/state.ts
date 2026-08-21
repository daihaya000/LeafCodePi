export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
};

const MAX_TODOS = 100;
const MAX_CONTENT_CHARS = 2_000;
const MAX_ID_CHARS = 120;

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function safeId(value: string): string {
  return value.trim().slice(0, MAX_ID_CHARS);
}

function nextId(index: number, used: Set<string>): string {
  let id = `todo-${index + 1}`;
  let suffix = 2;
  while (used.has(id)) id = `todo-${index + 1}-${suffix++}`;
  return id;
}

export function normalizeTodos(
  value: unknown,
  previous: readonly TodoItem[] = [],
): { todos: TodoItem[]; error?: string } {
  if (!Array.isArray(value)) return { todos: [...previous], error: "todos は配列で指定してください。" };
  if (value.length > MAX_TODOS) {
    return { todos: [...previous], error: `Todo は ${MAX_TODOS} 件までです。` };
  }

  const todos: TodoItem[] = [];
  const used = new Set<string>();
  let inProgress = 0;
  for (let index = 0; index < value.length; index += 1) {
    const raw = asRecord(value[index]);
    const content = typeof raw?.content === "string" ? raw.content.trim() : "";
    const status = raw?.status;
    const priority = raw?.priority;
    if (!content || content.length > MAX_CONTENT_CHARS) {
      return { todos: [...previous], error: `Todo #${index + 1} の content が不正です。` };
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") {
      return { todos: [...previous], error: `Todo #${index + 1} の status が不正です。` };
    }
    if (priority !== "high" && priority !== "medium" && priority !== "low") {
      return { todos: [...previous], error: `Todo #${index + 1} の priority が不正です。` };
    }
    if (status === "in_progress") inProgress += 1;
    if (inProgress > 1) {
      return { todos: [...previous], error: "in_progress の Todo は同時に1件だけにしてください。" };
    }

    const requestedId = typeof raw?.id === "string" ? safeId(raw.id) : "";
    const previousMatch = previous.find(
      (item) => !used.has(item.id) && item.content === content,
    );
    const id = requestedId || previousMatch?.id || nextId(index, used);
    if (!id || used.has(id)) {
      return { todos: [...previous], error: `Todo #${index + 1} の id が重複しています。` };
    }
    used.add(id);
    todos.push({ id, content, status, priority });
  }
  return { todos };
}
