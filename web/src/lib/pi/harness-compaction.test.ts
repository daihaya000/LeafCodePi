import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCompactionSuggestions } from "./harness";

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("./web-settings", () => ({ getSetting: (key: string) => settings.get(key) ?? null }));

const globalState = globalThis as Record<string, unknown>;
const previousState = globalState.__leafcodePiHarness;
afterEach(() => {
  if (previousState === undefined) delete globalState.__leafcodePiHarness;
  else globalState.__leafcodePiHarness = previousState;
  settings.clear();
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
