import { describe, expect, it, vi } from "vitest";
import { liveGoalLoopRestartBlock } from "./goal-loop-restart-guard";

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;
}

describe("liveGoalLoopRestartBlock", () => {
  it("blocks Backend / host restarts while a Goal Loop is live", async () => {
    const fetchImpl = fetchReturning({ active: 2, taskIds: ["a", "b"] });
    expect(await liveGoalLoopRestartBlock("backend", fetchImpl)).toContain("Goal Loop が 2 件実行中");
    expect(await liveGoalLoopRestartBlock("host", fetchImpl)).toContain("トレイホスト");
  });

  it("never probes for a WebUI restart", async () => {
    const fetchImpl = fetchReturning({ active: 3 });
    expect(await liveGoalLoopRestartBlock("webui", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open when the state is unknown or idle", async () => {
    expect(await liveGoalLoopRestartBlock("backend", fetchReturning({ active: 0 }))).toBeNull();
    expect(await liveGoalLoopRestartBlock("backend", fetchReturning({ error: "x" }, false))).toBeNull();
    const throwing = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await liveGoalLoopRestartBlock("host", throwing)).toBeNull();
  });
});
