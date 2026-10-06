import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCompactionSuggestions, sessionExtensionFactories } from "./harness";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionControllerOptions } from "./compaction-controller";

const compaction = vi.hoisted(() => ({
  register: vi.fn<(api: ExtensionAPI, options: CompactionControllerOptions) => void>(),
  loop: null as { status: string } | null,
}));
vi.mock("./compaction-controller", () => ({ registerCompactionController: compaction.register }));
vi.mock("@/lib/pi/goal-loop-state", async (original) => ({
  ...await original<typeof import("@/lib/pi/goal-loop-state")>(),
  readGoalLoopState: () => compaction.loop,
}));
vi.mock("@/lib/store", async (original) => ({
  ...await original<typeof import("@/lib/store")>(), getTask: () => undefined,
}));

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("./web-settings", () => ({ getSetting: (key: string) => settings.get(key) ?? null }));

const globalState = globalThis as Record<string, unknown>;
const previousState = globalState.__leafcodePiHarness;
afterEach(() => {
  if (previousState === undefined) delete globalState.__leafcodePiHarness;
  else globalState.__leafcodePiHarness = previousState;
  settings.clear();
  compaction.loop = null;
  compaction.register.mockClear();
});

describe("background compaction config", () => {
  it("uses separate preparation settings and excludes Goal Loop ownership", () => {
    const nativeSettings = { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 };
    const live = {
      goalLoopTurnActive: false,
      session: { sessionId: "test", sessionManager: { getCwd: () => process.cwd() },
        settingsManager: { getCompactionSettings: () => nativeSettings } },
    };
    globalState.__leafcodePiHarness = { live: new Map([["task", live]]), events: new EventEmitter() };
    sessionExtensionFactories({ agentDir: process.cwd(), taskId: "task", hasBotSkills: false,
      getExtensions: () => [] }).at(-1)!({} as ExtensionAPI);
    const config = compaction.register.mock.calls[0]![1].config;
    const ctx = { model: { provider: "test", id: "model", contextWindow: 100_000 } } as ExtensionContext;
    expect(config(ctx)).toMatchObject({ enabled: true, startPercent: 70, settings: nativeSettings });
    settings.set("compaction-background-threshold", "80");
    expect(config(ctx)).toMatchObject({ enabled: true, startPercent: 80, settings: nativeSettings });
    for (const status of ["running", "paused", "blocked"]) {
      compaction.loop = { status };
      expect(config(ctx)?.enabled).toBe(false);
    }
    compaction.loop = null;
    live.goalLoopTurnActive = true;
    expect(config(ctx)?.enabled).toBe(false);
    live.goalLoopTurnActive = false;
    settings.set("compaction-background-enabled", "0");
    expect(config(ctx)?.enabled).toBe(false);
    settings.delete("compaction-background-enabled");
    for (const action of ["suggest", "off"]) {
      settings.set("compactionAction", action);
      expect(config(ctx)?.enabled).toBe(false);
    }
    settings.set("compactionAction", "auto");
    nativeSettings.enabled = false;
    expect(config(ctx)?.enabled).toBe(false);
  });
});

describe("refreshCompactionSuggestions", () => {
  it("sends settings-only deltas and clears suggestions for off, auto and higher thresholds", () => {
    const events = new EventEmitter();
    const receive = vi.fn();
    const projectHistory = vi.fn(() => { throw new Error("history must not be projected"); });
    const session = {
      messages: [],
      getContextUsage: () => ({ tokens: 85, contextWindow: 100, percent: 85 }),
      sessionManager: { getCwd: () => { throw new Error("no goal loop"); }, getBranch: projectHistory },
    };
    globalState.__leafcodePiHarness = {
      live: new Map([["task", { taskId: "task", session, goalLoopTurnActive: false }]]),
      events,
    };
    events.on("task", receive);
    settings.set("compactionAction", "suggest");
    settings.set("compactionThreshold", "80");
    refreshCompactionSuggestions();
    expect(receive).toHaveBeenLastCalledWith({
      type: "delta", compactionSuggested: true, eventType: "compaction_settings_changed",
    });
    for (const [action, threshold] of [["off", "80"], ["auto", "80"], ["suggest", "90"]]) {
      settings.set("compactionAction", action!);
      settings.set("compactionThreshold", threshold!);
      refreshCompactionSuggestions();
      expect(receive).toHaveBeenLastCalledWith({
        type: "delta", compactionSuggested: false, eventType: "compaction_settings_changed",
      });
    }
    expect(projectHistory).not.toHaveBeenCalled();
  });

  it("suppresses active goal loops and skips sessions without listeners", () => {
    const events = new EventEmitter();
    const receive = vi.fn();
    const getContextUsage = vi.fn();
    globalState.__leafcodePiHarness = {
      live: new Map([
        ["loop", { taskId: "loop", session: { getContextUsage }, goalLoopTurnActive: true }],
        ["hidden", { taskId: "hidden", session: { getContextUsage }, goalLoopTurnActive: false }],
      ]),
      events,
    };
    events.on("loop", receive);
    settings.set("compactionAction", "suggest");
    refreshCompactionSuggestions();
    expect(receive).toHaveBeenCalledExactlyOnceWith({
      type: "delta", compactionSuggested: false, eventType: "compaction_settings_changed",
    });
    expect(getContextUsage).not.toHaveBeenCalled();
  });
});
