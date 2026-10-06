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
  // A rejected push is resolved by fetching and merging the remote before pushing again.
  "fetch", "merge",
]);
/** Pipe targets that only shape or filter output. */
const OUTPUT_FILTER = /^(select-object|select|select-string|out-string|measure-object|sort-object|where-object|head|tail|findstr|grep|wc|sort|more)\b/i;
const GIT_FORBIDDEN_FLAGS = /(^|\s)(--force(?:-with-lease|-if-includes)?(?:=[^\s]+)?|--hard|--amend|--rebase|--abort|--quit|-f)(?=\s|$)/i;

/** File-changing tools. A task that used one is a "change task" and owes a review step. */
export const FILE_CHANGE_TOOLS = new Set(["edit", "write"]);

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/**
 * True when every statement of a shell command is an allowed git status / commit / push call.
 * Used to let the commit and confirmation steps through once every ToDo item is completed.
 */
type ShellCommandShape = { statements: string[][]; malformed: boolean; dangerous: boolean };

/** Split on shell operators outside quotes and replace quoted arguments with neutral data. */
function parseShellCommand(command: string, toolName: string): ShellCommandShape {
  const statements: string[][] = [];
  let pipeline: string[] = [];
  let part = "";
  let quote: "single" | "double" | undefined;
  let malformed = false;
  let dangerous = false;
  const pushPart = () => {
    const trimmed = part.trim();
    if (trimmed) pipeline.push(trimmed);
    part = "";
  };
  const pushStatement = () => {
    pushPart();
    if (pipeline.length) statements.push(pipeline);
    pipeline = [];
  };
  const powershell = toolName === "powershell";

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote === "single") {
      if (powershell && char === "'" && next === "'") i += 1;
      else if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (!powershell && char === "\\") i += 1;
      else if (powershell && char === "`") i += 1;
      else if (char === '`' && !powershell) dangerous = true;
      else if (char === '"') quote = undefined;
      else if (char === "$" && (next === "(" || next === "{")) dangerous = true;
      continue;
    }
    if (char === "'") {
      quote = "single";
      part += " '' ";
      continue;
    }
    if (char === '"') {
      quote = "double";
      part += " '' ";
      continue;
    }
    if (char === "`") {
      // PowerShell uses this as an escape; POSIX uses it for command substitution. Reject conservatively.
      dangerous = true;
      continue;
    }
    if (char === "$" && (next === "(" || next === "{")) {
      dangerous = true;
      continue;
    }
    if (!powershell && char === "\\" && next !== undefined) {
      part += " ";
      i += 1;
      continue;
    }
    if (command.slice(i, i + 4) === "2>&1") {
      i += 3;
      continue;
    }
    if (char === "&" && next === "&") {
      pushStatement();
      i += 1;
      continue;
    }
    if (char === "<" || char === ">" || char === "(" || char === ")" || char === "&") {
      // A single ampersand backgrounds a POSIX command or invokes PowerShell's call operator.
      dangerous = true;
      continue;
    }
    if (char === "|") {
      if (next === "|") {
        pushStatement();
        i += 1;
      } else pushPart();
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      pushStatement();
      if (char === "\r" && next === "\n") i += 1;
      continue;
    }
    part += char;
  }
  if (quote) malformed = true;
  pushStatement();
  return { statements, malformed, dangerous };
}

export function isClosingShellCommand(command: unknown, toolName = "powershell"): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const parsed = parseShellCommand(command, toolName);
  if (parsed.malformed || parsed.dangerous || parsed.statements.length === 0) return false;
  const directoryChange = toolName === "powershell"
    ? /^(cd|set-location|pushd|sl)\s+\S/i
    : /^(cd|pushd)\s+\S/i;
  return parsed.statements.every((pipeline) => {
    const [head = "", ...filters] = pipeline;
    if (!filters.every((filter) => OUTPUT_FILTER.test(filter))) return false;
    if (directoryChange.test(head)) return true;
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
