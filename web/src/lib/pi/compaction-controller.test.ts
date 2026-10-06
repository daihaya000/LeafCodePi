import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext, SessionEntry, CompactionResult, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCompactionController, type CompactionConfig, type CompactionControllerOptions } from "./compaction-controller";
import type { CompactionPreparation } from "./prepare-background-compaction";

afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture() {
  vi.useFakeTimers();
  const hooks = new Map<string, ((event: never, ctx: ExtensionContext) => unknown)[]>();
  const bus = new EventEmitter();
  const phases: string[] = [];
  bus.on("leafcode:compaction:status", (event) => phases.push(event.phase));
  const api = {
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    events: { emit: (name: string, data: unknown) => { bus.emit(name, data); },
      on: (name: string, handler: (data: unknown) => void) => { bus.on(name, handler); return () => { bus.off(name, handler); }; } },
  } as unknown as ExtensionAPI;
  const state = {
    branch: [{ id: "old", type: "message" }, { id: "keep", type: "message" }] as SessionEntry[],
    sessionId: "session", percent: 75,
  };
  const signal = new AbortController();
  const ctx = {
    signal: signal.signal,
    sessionManager: { getBranch: () => state.branch, getSessionId: () => state.sessionId },
    getContextUsage: () => ({ percent: state.percent, tokens: state.percent * 1000, contextWindow: 100_000 }),
  } as unknown as ExtensionContext;
  const config: CompactionConfig = {
    enabled: true, startPercent: 70, key: "account/model/settings",
    settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
  };
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "keep", tokensBefore: 75_000, isSplitTurn: false,
    messagesToSummarize: [{ role: "user", content: "history ".repeat(500), timestamp: 1 }],
    turnPrefixMessages: [], fileOps: { read: new Set(), edited: new Set(), written: new Set() }, settings: config.settings,
  };
  const pending = Promise.withResolvers<CompactionResult | undefined>();
  const result: CompactionResult = { summary: "checkpoint", firstKeptEntryId: "keep", tokensBefore: 75_000, details: { test: true } };
  const options = {
    config: vi.fn(() => config), prepare: vi.fn(async () => preparation),
    summarize: vi.fn<CompactionControllerOptions["summarize"]>(() => pending.promise),
    timeoutMs: 50, cooldownMs: 100, minDeltaTokens: 0,
  };
  registerCompactionController(api, options);
  const emit = async (name: string, event: object = {}) => {
    let result: unknown;
    for (const handler of hooks.get(name) ?? []) result = await handler(event as never, ctx);
    return result as { entries?: SessionBoundaryDraft[]; compaction?: CompactionResult; continue?: boolean } | undefined;
  };
  const boundary = (entries: SessionBoundaryDraft[] = []) => emit("turn_end", { entries, continue: false });
  return { api, bus, phases, state, signal, ctx, config, preparation, pending, result, options, emit, boundary };
}

describe("background compaction controller", () => {
  it("claims ownership synchronously and releases it on shutdown", async () => {
    const f = fixture();
    const first = { claimed: false };
    f.api.events.emit("leafcode:compaction:owner", first);
    expect(first.claimed).toBe(true);
    await f.emit("session_shutdown");
    const after = { claimed: false };
    f.api.events.emit("leafcode:compaction:owner", after);
    expect(after.claimed).toBe(false);
  });

  it("does not block or duplicate work; applies only at a boundary and keeps new suffixes", async () => {
    const f = fixture();
    expect(await f.boundary()).toBeUndefined();
    await flush();
    expect(f.options.summarize).toHaveBeenCalledOnce();
    expect(await f.boundary()).toBeUndefined();
    f.state.branch.push({ id: "new", type: "message" } as SessionEntry);
    f.pending.resolve(f.result);
    await flush();
    expect(f.phases).toContain("ready");
    expect(f.state.branch).toHaveLength(3); // Completion never writes the log itself.
    const existing: SessionBoundaryDraft = { type: "custom", customType: "other" };
    const applied = await f.boundary([existing]);
    expect(applied?.entries).toEqual([existing, { type: "compaction", summary: "checkpoint",
      firstKeptEntryId: "keep", details: { test: true }, usage: undefined }]);
    expect(applied).not.toHaveProperty("continue"); // Do not wake a stopped/settled run.
    expect(await f.boundary()).toBeUndefined();
    expect(f.options.summarize).toHaveBeenCalledOnce();
  });

  it.each(["branch", "edit", "compaction", "model/account/settings", "session", "disabled"])(
    "discards results invalidated by %s", async (reason) => {
      const f = fixture();
      await f.boundary(); await flush(); f.pending.resolve(f.result); await flush();
      if (reason === "branch") f.state.branch[0] = { id: "other", type: "message" } as SessionEntry;
      if (reason === "edit") f.state.branch.push({ id: "edit", type: "context_edit" } as SessionEntry);
      if (reason === "compaction") f.state.branch.push({ id: "cmp", type: "compaction" } as SessionEntry);
      if (reason === "model/account/settings") f.config.key = "changed";
      if (reason === "session") f.state.sessionId = "different";
      if (reason === "disabled") f.config.enabled = false;
      expect(await f.boundary()).toBeUndefined();
      expect(f.phases).not.toContain("applied");
    },
  );

  it.each(["session_before_switch", "session_before_fork", "session_before_tree", "session_tree", "session_compact", "model_select", "session_shutdown"])(
    "aborts and ignores late completion on %s", async (event) => {
      const f = fixture();
      await f.boundary(); await flush();
      const request = f.options.summarize.mock.calls[0][0];
      await f.emit(event);
      expect(request.signal.aborted).toBe(true);
      f.pending.resolve(f.result); await flush();
      expect(await f.boundary()).toBeUndefined();
      expect(f.phases).not.toContain("ready");
    },
  );

  it("aborts on user stop, even after a summary is ready", async () => {
    const f = fixture();
    await f.boundary(); await flush(); f.pending.resolve(f.result); await flush();
    f.signal.abort();
    expect(await f.boundary()).toBeUndefined();
    expect(f.phases).not.toContain("applied");
  });

  it("times out without accumulating jobs when a provider ignores abort", async () => {
    const f = fixture();
    await f.boundary(); await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.options.summarize.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.phases).toContain("timeout");
    await f.boundary(); await flush();
    expect(f.options.summarize).toHaveBeenCalledOnce();
    f.pending.resolve(f.result); await flush();
    expect(f.phases).not.toContain("ready");
  });

  it("falls back to fresh foreground work after failure or an unfinished job", async () => {
    const f = fixture();
    await f.boundary(); await flush();
    f.options.summarize.mockResolvedValueOnce({ ...f.result, summary: "foreground" });
    const response = await f.emit("session_before_compact", {
      preparation: f.preparation, branchEntries: f.state.branch, reason: "threshold", signal: new AbortController().signal,
    });
    expect(response?.compaction?.summary).toBe("foreground");
    expect(f.options.summarize.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.options.summarize.mock.calls[1][0].mode).toBe("foreground");
    f.pending.reject(new Error("cancelled")); await flush();
  });

  it("reuses a ready result for native threshold but honors manual focus", async () => {
    const f = fixture();
    await f.boundary(); await flush(); f.pending.resolve(f.result); await flush();
    const event = { preparation: f.preparation, branchEntries: f.state.branch,
      reason: "threshold", signal: new AbortController().signal };
    expect((await f.emit("session_before_compact", event))?.compaction).toEqual(f.result);
    expect(f.options.summarize).toHaveBeenCalledOnce();
    f.options.summarize.mockResolvedValueOnce({ ...f.result, summary: "focus" });
    expect((await f.emit("session_before_compact", { ...event, reason: "manual", customInstructions: "focus errors" }))?.compaction?.summary).toBe("focus");
    expect(f.options.summarize.mock.calls[1][0].customInstructions).toBe("focus errors");
  });

  it("does not apply across another hook's uncommitted projection edits", async () => {
    const f = fixture();
    await f.boundary(); await flush(); f.pending.resolve(f.result); await flush();
    expect(await f.boundary([{ type: "context_edit", targetId: "old", replacement: null }])).toBeUndefined();
    expect(f.phases).not.toContain("applied");
  });

  it("does not start below the threshold or without meaningful new history", async () => {
    const f = fixture();
    f.state.percent = 50;
    await f.boundary(); await flush();
    expect(f.options.prepare).not.toHaveBeenCalled();
    f.state.percent = 80;
    f.options.prepare.mockResolvedValueOnce(undefined as never);
    await f.boundary(); await flush();
    expect(f.options.summarize).not.toHaveBeenCalled();
  });

  it("catches provider failure and enforces a retry cooldown", async () => {
    const f = fixture();
    await f.boundary(); await flush(); f.pending.reject(new Error("rate limited")); await flush();
    expect(f.phases).toContain("failed");
    await f.boundary(); await flush();
    expect(f.options.summarize).toHaveBeenCalledOnce();
  });

  it.each(["", "larger", "wrong-boundary"])("rejects unusable output: %s", async (value) => {
    const f = fixture();
    await f.boundary(); await flush();
    f.pending.resolve({ ...f.result,
      summary: value === "larger" ? "x".repeat(100_000) : value,
      firstKeptEntryId: value === "wrong-boundary" ? "old" : "keep" });
    await flush();
    expect(await f.boundary()).toBeUndefined();
    expect(f.phases).toContain("skipped");
  });
});
