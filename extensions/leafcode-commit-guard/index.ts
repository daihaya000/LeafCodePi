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
export type RepoMutationKind = "none" | "soft" | "hard";

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

/**
 * hard = edit/write/subagent/unknown tools (tree likely changed even if porcelain is stable)
 * soft = shell heuristics only (npm install etc.; often gitignored → fingerprint is authority)
 */
export function classifyRepoMutation(messages: AgentEndEvent["messages"]): RepoMutationKind {
  let soft = false;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      if (part.name === "edit" || part.name === "write" || part.name === "subagent") return "hard";
      if (part.name === "bash" || part.name === "powershell") {
        if (shellMayMutate(commandText(part.arguments))) soft = true;
        continue;
      }
      if (!READ_ONLY_TOOLS.has(part.name)) return "hard";
    }
  }
  return soft ? "soft" : "none";
}

/** Exported for the focused regression tests and future guard integrations. */
export function hasPotentialRepoMutation(messages: AgentEndEvent["messages"]): boolean {
  return classifyRepoMutation(messages) !== "none";
}

export function shouldRequestCommitGate(input: {
  initiallyDirty: boolean | undefined;
  dirty: boolean;
  statusChanged: boolean;
  hardMutation: boolean;
  reminderSent: boolean;
}): boolean {
  if (!input.dirty || input.reminderSent) return false;
  // Clean start: any dirt is enough (fingerprint/heuristic optional).
  if (input.initiallyDirty === false) return true;
  // Dirty or unknown baseline: fingerprint change is primary; hard tools are backup.
  // Soft shell heuristics alone must not fire (npm/ci on a pre-dirty tree).
  return input.statusChanged || input.hardMutation;
}

async function gitStatus(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      // OneDrive / large trees often exceed 5s; treat timeout as unknown, not clean.
      timeout: 15_000,
    });
    const killed = Boolean((result as { killed?: boolean }).killed);
    if (killed || result.code !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

function isDirty(status: string): boolean {
  return status.trim().length > 0;
}

export default function registerCommitGuard(pi: ExtensionAPI): void {
  // Child subagent sessions share the parent task's repository and must not
  // enqueue their own follow-up turns. The parent session owns the commit gate.
  if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

  let initiallyDirty: boolean | undefined;
  let initialStatusText: string | undefined;
  let hardMutationObserved = false;
  let mutationObserved = false;
  let reminderSent = false;
  let lastRemindedStatus: string | undefined;
  let sessionStartGeneration = 0;
  let sessionReady = false;
  let pendingSettledCtx: ExtensionContext | null = null;

  const resetCleanBaseline = (status: string): void => {
    hardMutationObserved = false;
    mutationObserved = false;
    reminderSent = false;
    lastRemindedStatus = undefined;
    initiallyDirty = false;
    initialStatusText = status;
  };

  const runCommitGate = async (ctx: ExtensionContext): Promise<void> => {
    const status = await gitStatus(pi, ctx.cwd);
    // Unknown git status must not look like a clean tree (would wipe gate state).
    if (status === undefined) return;

    if (!isDirty(status)) {
      resetCleanBaseline(status);
      return;
    }

    // Re-arm when the dirty fingerprint moves after a prior reminder (partial
    // commit leaving pre-existing dirt, then new task edits).
    if (reminderSent && lastRemindedStatus !== undefined && status !== lastRemindedStatus) {
      reminderSent = false;
    }

    // Dirty fingerprint change is the primary signal; hard tools are backup.
    const statusChanged =
      initialStatusText !== undefined && status !== initialStatusText;
    if (!shouldRequestCommitGate({
      initiallyDirty,
      dirty: true,
      statusChanged,
      hardMutation: hardMutationObserved,
      reminderSent,
    })) return;

    // Set before enqueueing because sendMessage is non-idempotent.
    reminderSent = true;
    lastRemindedStatus = status;
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
  };

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionStartGeneration;
    sessionReady = false;
    const status = await gitStatus(pi, ctx.cwd);
    if (generation !== sessionStartGeneration) return;

    const inFlight = mutationObserved || hardMutationObserved || reminderSent;
    if (inFlight) {
      // Preserve gate state across a late/slow session_start. Do not force
      // initiallyDirty=false (that turns pre-existing dirt into a false positive)
      // and do not overwrite the baseline fingerprint mid-flight.
      if (status !== undefined) {
        if (initiallyDirty === undefined) initiallyDirty = isDirty(status);
        if (initialStatusText === undefined) initialStatusText = status;
      }
    } else {
      initiallyDirty = status === undefined ? undefined : isDirty(status);
      hardMutationObserved = false;
      mutationObserved = false;
      reminderSent = false;
      lastRemindedStatus = undefined;
      initialStatusText = status;
    }
    sessionReady = true;
    if (pendingSettledCtx) {
      const pending = pendingSettledCtx;
      pendingSettledCtx = null;
      await runCommitGate(pending);
    }
  });

  pi.on("agent_end", (event) => {
    const kind = classifyRepoMutation(event.messages);
    if (kind === "hard") {
      hardMutationObserved = true;
      mutationObserved = true;
    } else if (kind === "soft") {
      mutationObserved = true;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!sessionReady) {
      pendingSettledCtx = ctx;
      return;
    }
    await runCommitGate(ctx);
  });
}
