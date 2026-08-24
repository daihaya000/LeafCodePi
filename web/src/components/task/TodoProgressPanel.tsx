"use client";

import { useState } from "react";
import { Check, ChevronRight, Circle, ListTodo, Loader2, Minus } from "lucide-react";
import { cx } from "@/components/ui";
import type { TodoDto } from "@/lib/types";

const PRIORITY_LABEL: Record<TodoDto["priority"], string> = {
  high: "高",
  medium: "中",
  low: "低",
};

function isDone(todo: TodoDto): boolean {
  return todo.status === "completed" || todo.status === "cancelled";
}

function TodoIcon({ todo }: { todo: TodoDto }) {
  if (todo.status === "completed") return <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />;
  if (todo.status === "cancelled") return <Minus className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />;
  if (todo.status === "in_progress") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-working" aria-hidden="true" />;
  return <Circle className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />;
}

export function TodoProgressPanel({ todos }: { todos: TodoDto[] }) {
  const [expanded, setExpanded] = useState(true);
  if (todos.length === 0) return null;

  const done = todos.filter(isDone).length;
  const percent = Math.round((done / todos.length) * 100);
  const current = todos.find((todo) => todo.status === "in_progress");
  const complete = done === todos.length;
  const headline = complete ? "ToDo完了" : current?.content ?? "作業中…";

  return (
    <section
      aria-label="ToDo進捗"
      aria-live="polite"
      className="mx-auto w-full max-w-5xl text-sm"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left text-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary sm:min-h-8"
      >
        {complete ? (
          <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-working" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{headline}</span>
        <span className="shrink-0 text-xs tabular-nums">ToDo {done}/{todos.length}</span>
        <span className={cx("shrink-0 text-xs tabular-nums", complete ? "text-success" : "text-working")}>
          {percent}%
        </span>
        <ChevronRight
          className={cx("h-3.5 w-3.5 shrink-0 text-faint transition-transform", expanded && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      <div
        role="progressbar"
        aria-label="ToDo完了率"
        aria-valuemin={0}
        aria-valuemax={todos.length}
        aria-valuenow={done}
        aria-valuetext={`${done}/${todos.length} 完了（${percent}%）`}
        className="ml-7 h-1.5 overflow-hidden rounded-full bg-surface-2"
        title={`${done}/${todos.length} 完了（${percent}%）`}
      >
        <div
          className={cx("h-full rounded-full transition-[width]", complete ? "bg-success" : "bg-working")}
          style={{ width: `${percent}%` }}
        />
      </div>
      {expanded && (
        <div className="mt-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-faint">
            <ListTodo className="h-3 w-3" aria-hidden="true" />
            <span>ToDo {done}/{todos.length}</span>
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {todos.map((todo) => (
              <li key={todo.id} className="flex min-w-0 items-center gap-2 text-xs">
                <TodoIcon todo={todo} />
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate",
                    isDone(todo) ? "text-faint line-through" : "text-text",
                  )}
                  title={todo.content}
                >
                  {todo.content}
                </span>
                <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] text-faint">
                  {PRIORITY_LABEL[todo.priority]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
