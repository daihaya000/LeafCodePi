import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const COMMIT_GATE_MESSAGE = [
  "Commit gate: this task left uncommitted changes in the Git worktree.",
  "Before finishing, inspect `git status --short`, `git diff`, and `git diff --cached`.",
  "Stage and commit only the changes belonging to the current task.",
  "Do not stage, discard, or rewrite unrelated or pre-existing changes.",
  "Use a concise Japanese commit message. If committing is impossible, report the exact reason instead of claiming completion.",
].join("\n");

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "question",
  "memory_search",
  "memory_add",
  "memory_replace",
  "memory_remove",
  "session_search",
  "skill_manage",
  "todowrite",
  "tool_search",
  "structured_output",
  "task_mutation_decision",
  "watchdog_permission_decision",
  "watchdog_warn",
  "contact_supervisor",
  "subagent_wait",
]);

const MUTATING_SHELL_PATTERNS = [
  /\bgit\s+(?:add|commit|apply|checkout|switch|restore|reset|clean|stash|merge|rebase|cherry-pick|mv|rm)\b/i,
  /\b(?:Set-Content|Add-Content|Out-File|Clear-Content|Export-Csv|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i,
  // File redirects (`>` / `>>`) but not fd redirects like `2>&1`.
  /(?<![0-9])>{1,2}(?!&)/,
  /(?:^|[;&|()\s])(?:rm|mv|cp|mkdir|touch|del|erase|patch)\s+/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|ci)\b/i,
  /\b(?:pip|pip3)\s+install\b/i,
  /\bcargo\s+(?:build|install|add)\b/i,
];

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function commandText(value: unknown): string {
  const args = asRecord(value);
  if (!args) return typeof value === "string" ? value : "";
  for (const key of ["command", "cmd", "script"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return "";
}

function shellMayMutate(command: string): boolean {
  return MUTATING_SHELL_PATTERNS.some((pattern) => pattern.test(command));
}

/** Exported for the focused regression tests and future guard integrations. */
export function hasPotentialRepoMutation(messages: AgentEndEvent["messages"]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      if (part.name === "edit" || part.name === "write" || part.name === "subagent") return true;
      if (part.name === "bash" || part.name === "powershell") {
        if (shellMayMutate(commandText(part.arguments))) return true;
        continue;
      }
      if (!READ_ONLY_TOOLS.has(part.name)) return true;
    }
  }
  return false;
}

export function shouldRequestCommitGate(input: {
  initiallyDirty: boolean | undefined;
  dirty: boolean;
  mutationObserved: boolean;
  reminderSent: boolean;
}): boolean {
  return input.dirty
    && !input.reminderSent
    && (input.initiallyDirty === false || input.mutationObserved);
}

async function gitStatus(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      timeout: 5_000,
    });
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function isDirty(status: string | undefined): boolean {
  return status !== undefined && status.trim().length > 0;
}

export default function registerCommitGuard(pi: ExtensionAPI): void {
  // Child subagent sessions share the parent task's repository and must not
  // enqueue their own follow-up turns. The parent session owns the commit gate.
  if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

  let initiallyDirty: boolean | undefined;
  let initialStatusText: string | undefined;
  let mutationObserved = false;
  let reminderSent = false;

  pi.on("session_start", async (_event, ctx) => {
    const status = await gitStatus(pi, ctx.cwd);
    initiallyDirty = status === undefined ? undefined : isDirty(status);
    initialStatusText = status;
    mutationObserved = false;
    reminderSent = false;
  });

  pi.on("agent_end", (event) => {
    if (hasPotentialRepoMutation(event.messages)) mutationObserved = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const status = await gitStatus(pi, ctx.cwd);
    if (!isDirty(status)) {
      mutationObserved = false;
      reminderSent = false;
      return;
    }
    // Dirty fingerprint change is the primary signal; shell heuristics are backup.
    const statusChanged =
      initialStatusText !== undefined && status !== undefined && status !== initialStatusText;
    if (!shouldRequestCommitGate({
      initiallyDirty,
      dirty: true,
      mutationObserved: mutationObserved || statusChanged,
      reminderSent,
    })) return;

    // Set before enqueueing because sendMessage is non-idempotent.
    reminderSent = true;
    try {
      pi.sendMessage(
        {
          customType: "leafcode-commit-gate",
          content: COMMIT_GATE_MESSAGE,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      if (ctx.hasUI) ctx.ui.notify("未コミット変更を検出しました。差分確認後にコミットします。", "warning");
    } catch (error) {
      console.error("Failed to enqueue the Git commit gate:", error);
    }
  });
}
