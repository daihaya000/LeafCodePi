import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
  AgentBeforeSettleEvent, BoundaryResult, CompactionResult,
  ExtensionAPI, ExtensionContext, SessionEntry, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation, ResolvedCompactionSettings } from "./prepare-background-compaction";

export type CompactionConfig = {
  enabled: boolean;
  startPercent: number;
  settings: ResolvedCompactionSettings;
  /** Account, session model, summarizer and live settings identity. */
  key: string;
};

export type CompactionControllerOptions = {
  config: (ctx: ExtensionContext) => CompactionConfig | undefined;
  prepare: (branch: SessionEntry[], settings: ResolvedCompactionSettings) => Promise<CompactionPreparation | undefined>;
  summarize: (input: {
    preparation: CompactionPreparation;
    branch: SessionEntry[];
    ctx: ExtensionContext;
    signal: AbortSignal;
    customInstructions?: string;
    mode: "foreground" | "background";
  }) => Promise<CompactionResult | undefined>;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
  minDeltaTokens?: number;
};

type Job = {
  sessionId: string;
  key: string;
  ids: string[];
  controller: AbortController;
  result?: CompactionResult;
  cleanup: () => void;
};

/** Pi's log is append-only. A new edit/compaction invalidates the compiled projection. */
function matches(job: Job, ctx: ExtensionContext, config: CompactionConfig | undefined, branch: SessionEntry[]): boolean {
  return Boolean(config?.enabled && config.key === job.key &&
    ctx.sessionManager.getSessionId() === job.sessionId &&
    !job.controller.signal.aborted && !ctx.signal?.aborted &&
    branch.length >= job.ids.length &&
    job.ids.every((id, index) => branch[index]?.id === id) &&
    !branch.slice(job.ids.length).some((entry) => entry.type === "compaction" || entry.type === "context_edit"));
}

/**
 * Sole LCP owner. Compile an immutable prefix in the background, then hand a draft
 * to Pi at a safe boundary. No log writes, extra turns, or deterministic lossy fallback.
 */
export function registerCompactionController(pi: ExtensionAPI, options: CompactionControllerOptions): void {
  const now = options.now ?? Date.now;
  let job: Job | undefined;
  // Keep the slot occupied until the provider actually settles, even if it ignores abort.
  let inFlight: Promise<void> | undefined;
  let foreground = false;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  const report = (phase: string) => {
    try { pi.events.emit("leafcode:compaction:status", { phase }); } catch { /* telemetry is non-critical */ }
  };
  const cancel = () => {
    const previous = job;
    job = undefined;
    if (previous) {
      previous.controller.abort();
      previous.cleanup();
      report("cancelled");
    }
  };
  const releaseOwner = pi.events.on("leafcode:compaction:owner", (data) => {
    if (data && typeof data === "object") (data as { claimed: boolean }).claimed = true;
  });

  const consumeReady = () => {
    if (!job?.result) return undefined;
    const result = job.result;
    job.cleanup();
    job = undefined;
    lastAttempt = now();
    report("applied");
    return result;
  };
  const takeReady = (ctx: ExtensionContext, config: CompactionConfig | undefined, branch: SessionEntry[]) => {
    if (job && !matches(job, ctx, config, branch)) cancel();
    return consumeReady();
  };

  const start = (ctx: ExtensionContext, config: CompactionConfig, branch: SessionEntry[]) => {
    const controller = new AbortController();
    const candidate: Job = {
      sessionId: ctx.sessionManager.getSessionId(), key: config.key,
      ids: branch.map((entry) => entry.id), controller, cleanup: () => {},
    };
    const onAbort = () => { if (job === candidate) cancel(); };
    const timer = setTimeout(() => {
      if (job !== candidate) return;
      cancel();
      lastAttempt = now();
      report("timeout");
    }, options.timeoutMs ?? 120_000);
    timer.unref?.();
    const sourceSignal = ctx.signal;
    sourceSignal?.addEventListener("abort", onAbort, { once: true });
    candidate.cleanup = () => {
      clearTimeout(timer);
      sourceSignal?.removeEventListener("abort", onAbort);
    };
    job = candidate;
    lastAttempt = now();
    report("running");
    // Do not await this from a turn hook: the next model/tool iteration keeps running.
    inFlight = Promise.resolve().then(async () => {
      const preparation = await options.prepare(branch, { ...config.settings });
      if (job !== candidate || controller.signal.aborted) return;
      if (!preparation) { cancel(); return; }
      // Count semantic message content with Pi's estimator. JSON.stringify of the
      // entire transcript duplicated large histories in memory on the event loop.
      const sourceTokens = preparation.messagesToSummarize.reduce((sum, message) => sum + estimateTokens(message), 0) +
        preparation.turnPrefixMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
      if (sourceTokens < (options.minDeltaTokens ?? 6_000)) { cancel(); return; }
      const result = await options.summarize({ preparation, branch, ctx, signal: controller.signal, mode: "background" });
      if (job !== candidate || controller.signal.aborted) return;
      if (!result?.summary.trim() || result.firstKeptEntryId !== preparation.firstKeptEntryId ||
        !candidate.ids.includes(result.firstKeptEntryId) ||
        Math.ceil(result.summary.length / 4) >= sourceTokens + Math.ceil((preparation.previousSummary?.length ?? 0) / 4)) {
        cancel();
        report("skipped");
        return;
      }
      candidate.result = result;
      // The request timer is finished, but retain abort handling until the draft is consumed.
      clearTimeout(timer);
      report("ready");
    }).catch(() => {
      if (job === candidate) {
        cancel();
        lastAttempt = now();
        report("failed");
      }
    }).finally(() => {
      inFlight = undefined;
      if (job !== candidate) candidate.cleanup();
    });
  };

  const boundary = (event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined => {
    try {
      const config = options.config(ctx);
      if (!config?.enabled || ctx.signal?.aborted) { cancel(); return; }
      // Another extension's pending projection has not been persisted yet. Never
      // compile or commit across it, nor drop its drafts/continuation decision.
      if (event.entries.some((entry) => entry.type === "compaction" || entry.type === "context_edit")) {
        cancel();
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const snapshotMatches = job ? matches(job, ctx, config, branch) : false;
      if (job && !snapshotMatches) cancel();
      const usage = ctx.getContextUsage();
      if (typeof usage?.percent !== "number" || !Number.isFinite(usage.percent) ||
        typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens) ||
        !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return;
      // Preparation is speculative, application is not. Match Pi's strict
      // native trigger; a ready checkpoint must not lower the user's threshold.
      const atNativeThreshold = usage.tokens > usage.contextWindow - config.settings.reserveTokens;
      // snapshotMatches already checked the full prefix above; avoid a second O(n) scan.
      const ready = atNativeThreshold && snapshotMatches ? consumeReady() : undefined;
      if (ready) return {
        entries: [...event.entries, {
          type: "compaction", summary: ready.summary, firstKeptEntryId: ready.firstKeptEntryId,
          details: ready.details, usage: ready.usage,
        }],
      };
      if (job || inFlight || foreground || atNativeThreshold ||
        now() - lastAttempt < (options.cooldownMs ?? 30_000)) return;
      const nativeThreshold = 100 * (1 - config.settings.reserveTokens / usage.contextWindow);
      const startPercent = Math.max(0, Math.min(config.startPercent, nativeThreshold - 5));
      if (usage.percent < startPercent) return;
      start(ctx, config, [...branch]);
    } catch {
      // Bad settings, a disappearing session, or a projection error must never break the run.
      cancel();
      lastAttempt = now();
      report("failed");
    }
  };

  pi.on("turn_end", boundary);
  pi.on("agent_before_settle", boundary);
  pi.on("session_before_compact", async (event, ctx) => {
    // A user-requested focus must always get a fresh summary. Overflow recovery may
    // also have appended edits; matches() rejects any snapshot predating those edits.
    const ready = event.reason !== "manual" && !event.customInstructions?.trim()
      ? takeReady(ctx, options.config(ctx), event.branchEntries) : undefined;
    cancel();
    if (ready) return { compaction: ready };
    foreground = true;
    try {
      const compaction = await options.summarize({
        preparation: event.preparation, branch: event.branchEntries, ctx,
        signal: event.signal, customInstructions: event.customInstructions, mode: "foreground",
      });
      event.signal.throwIfAborted();
      return compaction ? { compaction } : undefined;
    } finally {
      foreground = false;
      lastAttempt = now();
    }
  });
  pi.on("session_start", () => { cancel(); lastAttempt = Number.NEGATIVE_INFINITY; });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_tree", cancel);
  pi.on("session_compact", cancel);
  pi.on("model_select", cancel);
  pi.on("session_shutdown", () => { cancel(); releaseOwner(); });
}
