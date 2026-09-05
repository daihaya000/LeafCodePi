import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isSettleFollowUpClaimed,
  markSettleFollowUpClaimed,
  prepareSettleFollowUpClaim,
} from "../settle-followup-claim.ts";

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Must match web/src/lib/commit-guard-config.ts COMMIT_GUARD_CONFIG_FILE. */
const CONFIG_FILE = "commit-guard.json";
const DEFAULT_FEATURE_ENABLED = true;
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

/** Tools that mutate the worktree even when porcelain stays unchanged. */
const HARD_MUTATING_TOOLS = new Set(["edit", "write", "subagent"]);

const MUTATING_SHELL_PATTERNS = [
  /\bgit\s+(?:add|commit|apply|checkout|switch|restore|reset|clean|stash|merge|rebase|cherry-pick|pull|am|revert|mv|rm)\b/i,
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
 * hard = edit/write/subagent (tree likely changed even if porcelain is stable)
 * soft = shell heuristics or other unknown tools (fingerprint is authority)
 */
export function classifyRepoMutation(messages: AgentEndEvent["messages"]): RepoMutationKind {
  let soft = false;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      if (HARD_MUTATING_TOOLS.has(part.name)) return "hard";
      if (part.name === "bash" || part.name === "powershell") {
        if (shellMayMutate(commandText(part.arguments))) soft = true;
        continue;
      }
      // Unknown / read-ish tools: soft at most so pre-dirty + stable porcelain
      // does not false-positive. Fingerprint remains the primary signal.
      if (!READ_ONLY_TOOLS.has(part.name)) soft = true;
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
  softMutation?: boolean;
  reminderSent: boolean;
}): boolean {
  if (!input.dirty || input.reminderSent) return false;
  // Clean start: any dirt is enough (fingerprint/heuristic optional).
  if (input.initiallyDirty === false) return true;
  // Unknown baseline (start git failed): hard tools or soft+dirt — fingerprint
  // cannot be compared, so soft heuristics must count or npm/etc. is silent.
  if (input.initiallyDirty === undefined) {
    return input.hardMutation || Boolean(input.softMutation);
  }
  // Dirty baseline: fingerprint change is primary; hard tools are backup.
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

function sessionStartReason(event: unknown): string | undefined {
  const record = asRecord(event);
  return typeof record?.reason === "string" ? record.reason : undefined;
}

function leafcodeDataDir(): string {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

/**
 * Feature toggle only — the extension stays loaded for WebUI. Default: on.
 * Reads the same file as web/src/lib/commit-guard-config.ts.
 */
export function isCommitGuardFeatureEnabled(): boolean {
  try {
    const file = join(leafcodeDataDir(), CONFIG_FILE);
    if (!existsSync(file)) return DEFAULT_FEATURE_ENABLED;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown };
    return typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_FEATURE_ENABLED;
  } catch {
    return DEFAULT_FEATURE_ENABLED;
  }
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
  let gateRunning = false;
  let queuedSettledCtx: ExtensionContext | null = null;
  let baselineCapture: Promise<void> | null = null;
  let preToolBaselineFailed = false;

  const hasBaseline = (): boolean =>
    initiallyDirty !== undefined || initialStatusText !== undefined;

  const adoptBaseline = (status: string | undefined): void => {
    if (hasBaseline()) return;
    initiallyDirty = status === undefined ? undefined : isDirty(status);
    initialStatusText = status;
  };

  const ensureBaselineBeforeMutation = async (cwd: string): Promise<void> => {
    if (hasBaseline()) return;
    if (baselineCapture) {
      await baselineCapture;
      return;
    }
    baselineCapture = (async () => {
      const status = await gitStatus(pi, cwd);
      if (status === undefined) {
        if (!hasBaseline()) preToolBaselineFailed = true;
        return;
      }
      adoptBaseline(status);
    })();
    try {
      await baselineCapture;
    } finally {
      baselineCapture = null;
    }
  };

  const resetCleanBaseline = (status: string): void => {
    hardMutationObserved = false;
    mutationObserved = false;
    reminderSent = false;
    lastRemindedStatus = undefined;
    initiallyDirty = false;
    initialStatusText = status;
    preToolBaselineFailed = false;
  };

  const clearTaskMutationFlags = (): void => {
    hardMutationObserved = false;
    mutationObserved = false;
    reminderSent = false;
    lastRemindedStatus = undefined;
  };

  const evaluateCommitGate = async (ctx: ExtensionContext): Promise<void> => {
    // Extension remains registered; settings only disable the settle follow-up.
    if (!isCommitGuardFeatureEnabled()) return;

    const status = await gitStatus(pi, ctx.cwd);
    // Unknown git status must not look like a clean tree (would wipe gate state).
    if (status === undefined) return;

    if (!isDirty(status)) {
      resetCleanBaseline(status);
      return;
    }

    // Task dirt was committed away: fingerprint matches the pre-task baseline.
    // Clear sticky hard/soft flags so pre-existing dirt alone does not re-fire.
    // Exception: hard tools with unchanged porcelain still need one gate before
    // any reminder has been sent (edit/write may not move porcelain).
    if (initialStatusText !== undefined && status === initialStatusText) {
      if (!(hardMutationObserved && !reminderSent)) {
        clearTaskMutationFlags();
        return;
      }
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
      softMutation: mutationObserved,
      reminderSent,
    })) return;

    // Another settle-time gate (e.g. todowrite) already fired this turn.
    if (isSettleFollowUpClaimed()) return;

    // Latch only after a successful enqueue — failures must retry next settle.
    try {
      pi.sendMessage(
        {
          customType: "leafcode-commit-gate",
          content: COMMIT_GATE_MESSAGE,
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      markSettleFollowUpClaimed();
      reminderSent = true;
      lastRemindedStatus = status;
      if (ctx.hasUI) ctx.ui.notify("未コミット変更を検出しました。差分確認後にコミットします。", "warning");
    } catch (error) {
      console.error("Failed to enqueue the Git commit gate:", error);
    }
  };

  const runCommitGate = async (ctx: ExtensionContext): Promise<void> => {
    if (gateRunning) {
      queuedSettledCtx = ctx;
      return;
    }
    gateRunning = true;
    try {
      let current: ExtensionContext | null = ctx;
      while (current) {
        queuedSettledCtx = null;
        await evaluateCommitGate(current);
        current = queuedSettledCtx;
      }
    } finally {
      gateRunning = false;
    }
  };

  pi.on("session_start", async (event, ctx) => {
    const generation = ++sessionStartGeneration;
    sessionReady = false;
    const reason = sessionStartReason(event);
    const recovering = reason === "reload" || reason === "resume";
    const inFlightAtStart = mutationObserved || hardMutationObserved || reminderSent;
    // Idle re-entry: drop a prior session baseline before re-probing. Keep any
    // baseline if gate work is already in flight (late/slow start race).
    if (!inFlightAtStart) {
      initiallyDirty = undefined;
      initialStatusText = undefined;
    }
    const status = await gitStatus(pi, ctx.cwd);
    if (generation !== sessionStartGeneration) return;

    const inFlight = mutationObserved || hardMutationObserved || reminderSent;
    if (inFlight) {
      // Preserve gate state across a late/slow session_start. Do not force
      // initiallyDirty=false (that turns pre-existing dirt into a false positive)
      // and do not overwrite an existing baseline fingerprint mid-flight.
      // If a pre-tool snapshot failed and mutations already ran, leave baseline
      // unknown (soft/hard heuristics still gate) instead of adopting post-mutation dirt.
      if (!(preToolBaselineFailed && (mutationObserved || hardMutationObserved))) {
        adoptBaseline(status);
      }
    } else if (recovering) {
      // Remount wiped in-memory flags. Conservatively treat dirty/unknown reload
      // as needing a gate so task work is not absorbed as baseline — including
      // when the remount probe itself fails (OneDrive timeout).
      initiallyDirty = false;
      hardMutationObserved = false;
      mutationObserved = false;
      reminderSent = false;
      lastRemindedStatus = undefined;
      initialStatusText = status !== undefined && !isDirty(status) ? status : "";
      preToolBaselineFailed = false;
    } else {
      // Fresh start — keep a pre-tool baseline if tool_call won the race.
      adoptBaseline(status);
      hardMutationObserved = false;
      mutationObserved = false;
      reminderSent = false;
      lastRemindedStatus = undefined;
      preToolBaselineFailed = false;
    }
    sessionReady = true;
    if (pendingSettledCtx) {
      const pending = pendingSettledCtx;
      pendingSettledCtx = null;
      await runCommitGate(pending);
    }
  });

  // Snapshot porcelain before the first mutating tool so a slow session_start
  // cannot adopt post-mutation dirt as the "initial" baseline.
  pi.on("tool_call", async (event, ctx) => {
    if (hasBaseline()) return;
    const name = event.toolName;
    if (READ_ONLY_TOOLS.has(name)) return;
    if (name === "bash" || name === "powershell") {
      if (!shellMayMutate(commandText(event.input))) return;
    } else if (!HARD_MUTATING_TOOLS.has(name)) {
      // Unknown tools are soft: still need a pre-execution snapshot when the
      // session_start probe has not finished yet.
    }
    await ensureBaselineBeforeMutation(ctx.cwd);
  });

  pi.on("agent_end", (event) => {
    prepareSettleFollowUpClaim();
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
