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

export function isReviewTodo(todo: TodoItem): boolean {
  return REVIEW_PATTERN.test(todo.content);
}
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Git subcommands that belong to the commit / confirm phase after every item is completed. */
const CLOSING_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "add", "commit", "push", "rev-parse", "ls-files", "check-ignore",
  // A rejected push is resolved by fetching and merging the remote before pushing again.
  "fetch", "merge",
]);
/** Pipe targets that only shape or filter output. */
const OUTPUT_FILTER = /^(select-object|select|select-string|out-string|measure-object|sort-object|where-object|head|tail|findstr|grep|wc|sort|more)(?=\s|$)/i;
const FILTER_FORBIDDEN_FLAGS = /(^|\s)(--(?:output|compress-program)(?:=[^\s]*)?|-o[^\s]*)(?=\s|$)/i;
// GNU sort also accepts bundled short flags and abbreviated long flags. Only known read-only
// switches are safe after completion; unsupported arguments require an active ToDo instead.
const SAFE_SORT_ARGUMENT = /^(?:-[bdfghinrRsuVMcC]+|--(?:reverse|unique|numeric-sort|general-numeric-sort|human-numeric-sort|ignore-case|version-sort|stable|check)|-Unique|-Descending|-CaseSensitive)$/;
function isClosingOutputFilter(filter: string): boolean {
  const match = OUTPUT_FILTER.exec(filter);
  if (!match || FILTER_FORBIDDEN_FLAGS.test(filter)) return false;
  if (match[1]!.toLowerCase() !== "sort") return true;
  const args = filter.slice(match[0].length).trim();
  return !args || args.split(/\s+/).every((arg) => SAFE_SORT_ARGUMENT.test(arg));
}
const GIT_FORBIDDEN_FLAGS = /(^|\s)(--force(?:-with-lease|-if-includes)?(?:=[^\s]+)?|--hard|--amend|--rebase|--abort|--quit|--output(?:=[^\s]+)?|--ext-diff|--textconv|-[a-z]*f[a-z]*)(?=\s|$)/i;

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/**
 * True when every statement of a shell command is an allowed git status / commit / push call.
 * Used to let the commit and confirmation steps through once every ToDo item is completed.
 */
type ShellCommandShape = { statements: string[][]; malformed: boolean; dangerous: boolean };

/** Split outside quotes; neutralize quoted data but retain option names for forbidden-flag checks. */
function parseShellCommand(command: string, toolName: string): ShellCommandShape {
  const statements: string[][] = [];
  let pipeline: string[] = [];
  let part = "";
  let quote: "single" | "double" | undefined;
  let quoted = "";
  let malformed = false;
  let dangerous = false;
  let expectsPart = false;
  const pushPart = (required = false) => {
    const trimmed = part.trim();
    if (trimmed) pipeline.push(trimmed);
    else if (required || expectsPart) malformed = true;
    part = "";
    expectsPart = false;
  };
  const pushStatement = (required = false) => {
    pushPart(required);
    if (pipeline.length) statements.push(pipeline);
    pipeline = [];
  };
  const powershell = toolName === "powershell";
  const closeQuote = (next: string | undefined) => {
    // Adjacent fragments can construct hidden flags (e.g. "--fo"rce). Reject instead of guessing.
    if (next && !/[\s;|&]/.test(next)) malformed = true;
    const option = /^(--[a-z][\w-]*(?==|$))/i.exec(quoted);
    // Preserve complete option tokens, including values: dropping '=false' would turn
    // '--noEmit=false' into a verification flag; reducing '-uo' hides sort's write flag.
    part += option || /^-[a-z]/i.test(quoted) ? ` ${quoted} ` : " '' ";
    quote = undefined;
    quoted = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote === "single") {
      if (powershell && char === "'" && next === "'") { quoted += "'"; i += 1; }
      else if (char === "'") closeQuote(next);
      else quoted += char;
      continue;
    }
    if (quote === "double") {
      if ((!powershell && char === "\\") || (powershell && char === "`")) { quoted += next ?? ""; i += 1; }
      else if (char === '`' && !powershell) dangerous = true;
      else if (char === '"') closeQuote(next);
      else { if (char === "$") dangerous = true; quoted += char; }
      continue;
    }
    if (char === "'" || char === '"') {
      if (i > 0 && !/[\s;|&]/.test(command[i - 1]!)) malformed = true;
      quote = char === "'" ? "single" : "double";
      quoted = "";
      continue;
    }
    if (char === "`") {
      // PowerShell uses this as an escape; POSIX uses it for command substitution. Reject conservatively.
      dangerous = true;
      continue;
    }
    if (char === "$") {
      dangerous = true;
      continue;
    }
    if (!powershell && char === "\\" && next !== undefined) {
      dangerous = true; // Escaped unquoted fragments can build hidden flags (e.g. --fo\\rce).
      part += " ";
      i += 1;
      continue;
    }
    if (command.slice(i, i + 4) === "2>&1") {
      i += 3;
      continue;
    }
    if (char === "&" && next === "&") {
      pushStatement(true);
      expectsPart = true;
      i += 1;
      continue;
    }
    if (char === "<" || char === ">" || char === "(" || char === ")" || char === "{" || char === "}" || char === "&") {
      // A single ampersand backgrounds a POSIX command or invokes PowerShell's call operator.
      dangerous = true;
      continue;
    }
    if (char === "|") {
      if (next === "|") {
        pushStatement(true);
        i += 1;
      } else pushPart(true);
      expectsPart = true;
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

export type ClosingShellPhase = "confirmation" | "merge";
export type ReviewShellPhase = ClosingShellPhase | "verification";

// These are audit classifications, NOT execution/permission exceptions. Package scripts and
// unknown CLI options stay opaque: a script named "test" can still rewrite source files.
const VERIFICATION_OPTIONS: Record<string, ReadonlySet<string>> = {
  vitest: new Set(["--reporter", "--config", "--root", "--environment", "--pool", "--maxWorkers", "--minWorkers", "--testNamePattern", "-t", "--no-file-parallelism", "--passWithNoTests", "--silent"]),
  tsc: new Set(["--noEmit", "--project", "-p", "--pretty"]),
  eslint: new Set(["--max-warnings", "--format", "-f", "--config", "-c", "--no-warn-ignored"]),
};
function isVerificationCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] === "npx") tokens.splice(0, tokens[1] === "--no-install" ? 2 : 1);
  const executable = tokens.shift() ?? "";
  const allowed = Object.hasOwn(VERIFICATION_OPTIONS, executable) ? VERIFICATION_OPTIONS[executable] : undefined;
  if (!allowed) return false;
  if (executable === "vitest" && tokens.shift() !== "run") return false;
  if (executable === "tsc" && (!tokens.includes("--noEmit") || tokens.some((token) => token.startsWith("--noEmit=")))) return false;
  // The parser neutralizes quoted data, so even a quoted boolean is ambiguous here.
  // Require a terminal --noEmit or another option after it; never accept a value.
  if (executable === "tsc" && tokens.some((token, index) => token === "--noEmit"
    && tokens[index + 1] !== undefined && !tokens[index + 1]!.startsWith("-"))) return false;
  // PowerShell splatting can inject options such as --fix from an unseen variable.
  return tokens.every((token) => !token.startsWith("@")
    && (!token.startsWith("-") || allowed.has(token.split("=", 1)[0]!)));
}

/** Parse once; keep unsupported/ambiguous shell work review-affecting. */
export function classifyReviewShellCommand(command: unknown, toolName = "powershell"): ReviewShellPhase | undefined {
  if (typeof command !== "string" || !command.trim()) return undefined;
  const parsed = parseShellCommand(command, toolName);
  if (parsed.malformed || parsed.dangerous || parsed.statements.length === 0) return undefined;
  const directoryChange = toolName === "powershell"
    ? /^(cd|set-location|pushd|sl)\s+\S/i
    : /^(cd|pushd)\s+\S/i;
  let phase: ReviewShellPhase = "confirmation";
  const valid = parsed.statements.every((pipeline) => {
    const [head = "", ...filters] = pipeline;
    if (!filters.every(isClosingOutputFilter)) return false;
    if (directoryChange.test(head)) return true;
    if (isVerificationCommand(head)) {
      if (phase !== "merge") phase = "verification";
      return true;
    }
    const match = /^git(?:\s+-C\s+\S+)?\s+([a-z-]+)(.*)$/i.exec(head);
    if (!match) return false;
    const subcommand = match[1]!.toLowerCase();
    if (subcommand === "merge") phase = "merge";
    return CLOSING_GIT_SUBCOMMANDS.has(subcommand) && !GIT_FORBIDDEN_FLAGS.test(match[2] ?? "");
  });
  return valid ? phase : undefined;
}

/** Verification never grants closing-phase shell access. */
export function classifyClosingShellCommand(command: unknown, toolName = "powershell"): ClosingShellPhase | undefined {
  const phase = classifyReviewShellCommand(command, toolName);
  return phase === "verification" ? undefined : phase;
}

export function isClosingShellCommand(command: unknown, toolName = "powershell"): boolean {
  return classifyClosingShellCommand(command, toolName) !== undefined;
}

/** Verification/confirmation preserve a review; merges and opaque commands still invalidate it. */
export function isNonReviewShellCommand(command: unknown, toolName: string): boolean {
  const phase = classifyReviewShellCommand(command, toolName);
  return phase === "confirmation" || phase === "verification";
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
  /** A mutation-capable call was admitted, including opaque shell / custom tools. */
  reviewRequired: boolean;
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
  } else if (input.reviewRequired) {
    reasons.push(
      "変更系ツール実行後のレビューが未完了です。レビュー項目を in_progress にして差分・要件・テスト結果を確認し、確認後に completed へ更新してから報告してください。変更・未知shellの後も、進行中のレビューで read/grep または既知のGit確認・検証を正常終了すれば再確認できます。検証済みテストの再実行は不要です。",
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
    : "全ToDoが完了済みです。新しい作業なら todowrite で新規項目を登録し in_progress にしてください（レビュー済みならgit_finalizeでコミット・確認のみ可）。";
}

/** A short state note appended to each provider request while a list is being worked. */
export function buildStateNote(todos: readonly TodoItem[], reviewRequired = false): string | undefined {
  const open = listOpen(todos);
  if (!open) return reviewRequired
    ? "[ToDo状態] レビュー未完了。全項目completedでも終了不可。レビュー項目を再着手し、差分・要件・テスト結果をread/grepまたは既知のGit確認で確認してcompletedへ更新する。検証済みテストの再実行は不要。最終報告はまだ行わない。"
    : undefined;
  return `[ToDo状態] ${open}。完了した項目はその場で completed、次の項目を in_progress にする。`;
}
