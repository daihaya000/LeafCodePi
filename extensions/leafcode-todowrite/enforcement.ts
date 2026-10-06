/**
 * Pure helpers for the ToDo enforcement layer: closing-phase command detection,
 * the end-of-run audit (agent_before_settle) and the per-request state note.
 * Kept free of Pi APIs so the rules are unit-testable on their own.
 */

import type { TodoItem } from "./state.ts";

/** Mutating calls a Jev waiver may admit before it expires for the rest of the task. */
export const WAIVER_MUTATION_LIMIT = 3;
/** Forced continuations per task from the end-of-run audit. Bounded so it can never loop. */
export const STOP_CONTINUATION_LIMIT = 2;

const MAX_LISTED_ITEMS = 5;
const MAX_ITEM_CHARS = 80;
const REVIEW_PATTERN = /レビュー|review/i;
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Git subcommands that belong to the commit / confirm phase after every item is completed. */
const CLOSING_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "add", "commit", "push", "rev-parse", "ls-files", "check-ignore",
]);
/** Pipe targets that only shape or filter output. */
const OUTPUT_FILTER = /^(select-object|select|select-string|out-string|measure-object|sort-object|where-object|head|tail|findstr|grep|wc|sort|more)\b/i;
const GIT_FORBIDDEN_FLAGS = /(^|\s)(--force|--force-with-lease|-f|--hard|--amend)(\s|$)/;

/** File-changing tools. A task that used one is a "change task" and owes a review step. */
export const FILE_CHANGE_TOOLS = new Set(["edit", "write"]);

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/**
 * True when every statement of a shell command is an allowed git status / commit / push call.
 * Used to let the commit and confirmation steps through once every ToDo item is completed.
 */
export function isClosingShellCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  // Command substitution, redirection and subshells can hide work behind a git prefix.
  const bare = command.replace(/2>&1/g, "");
  if (/[`<>]|\$\(|\$\{/.test(bare)) return false;
  const statements = bare.split(/\r?\n|;|&&|\|\|/).map((part) => part.trim()).filter(Boolean);
  if (statements.length === 0) return false;
  return statements.every((statement) => {
    // A pipe into Select-Object / head / findstr only shapes git output.
    const [head = "", ...filters] = statement.split("|").map((part) => part.trim());
    if (!filters.every((filter) => OUTPUT_FILTER.test(filter))) return false;
    const match = /^git(?:\s+-C\s+\S+)?\s+([a-z-]+)(.*)$/i.exec(head);
    if (!match) return false;
    const subcommand = match[1]!.toLowerCase();
    return CLOSING_GIT_SUBCOMMANDS.has(subcommand) && !GIT_FORBIDDEN_FLAGS.test(match[2] ?? "");
  });
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_ITEM_CHARS ? `${single.slice(0, MAX_ITEM_CHARS - 1)}…` : single;
}

function listOpen(todos: readonly TodoItem[]): string {
  const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  const shown = open.slice(0, MAX_LISTED_ITEMS).map((todo) => `${todo.status}: ${clip(todo.content)}`);
  if (open.length > shown.length) shown.push(`他${open.length - shown.length}件`);
  return shown.join(" / ");
}

export type AuditInput = {
  todos: readonly TodoItem[];
  /** A list with an in_progress item was registered during this task. */
  openedThisTask: boolean;
  /** The ToDo gate stopped a call and no list was registered afterwards. */
  violationObserved: boolean;
  /** A Jev waiver is active for this task. */
  waived: boolean;
  /** edit / write calls admitted during this task. */
  fileChanges: number;
};

/** The reasons the run may not settle yet. Empty when the task is in good order. */
export function auditTask(input: AuditInput): string[] {
  const reasons: string[] = [];
  if (!input.openedThisTask) {
    if (input.violationObserved && !input.waived) {
      reasons.push(
        "ToDoが未起票のまま作業が止まっています。todowrite で項目を登録し、着手項目を in_progress にして作業を再開してください。",
      );
    }
    return reasons;
  }
  const unfinished = listOpen(input.todos);
  if (unfinished) {
    reasons.push(
      `未完了のToDoが残っています（${unfinished}）。実施して completed にするか、不要なら cancelled にして todowrite を更新してから報告してください。`,
    );
  } else if (input.fileChanges > 0 && !input.todos.some((todo) => REVIEW_PATTERN.test(todo.content))) {
    reasons.push(
      "ファイルを変更したがレビュー工程のToDoがありません。差分・要件・テストをレビューし、結果を todowrite のレビュー項目（completed）に反映してから報告してください。",
    );
  }
  return reasons;
}

export function buildStopMessage(reasons: readonly string[]): string {
  return ["ToDo運用の点検で終了前に是正が必要です。", ...reasons.map((reason) => `- ${reason}`)].join("\n");
}

export function blockedWhenClosedReason(todos: readonly TodoItem[]): string {
  const open = listOpen(todos);
  return open
    ? `進行中のToDoがありません（${open}）。次の項目を in_progress にして todowrite を更新してから作業してください。`
    : "全ToDoが完了済みです。新しい作業なら todowrite で新規項目を登録し in_progress にしてください（コミット・確認のgit操作のみ可）。";
}

/** A short state note appended to each provider request while a list is being worked. */
export function buildStateNote(todos: readonly TodoItem[]): string | undefined {
  if (todos.length === 0) return undefined;
  const open = listOpen(todos);
  if (!open) return undefined;
  return `[ToDo状態] ${open}。完了した項目はその場で completed、次の項目を in_progress にする。`;
}
