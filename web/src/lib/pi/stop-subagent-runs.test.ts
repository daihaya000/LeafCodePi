import { describe, expect, it, vi } from "vitest";
import { stopRunningSubagentRuns } from "./stop-subagent-runs";

describe("stopRunningSubagentRuns", () => {
  it("stops all running runs and ignores terminal rows", async () => {
    const stop = vi.fn(async () => undefined);
    const result = await stopRunningSubagentRuns(
      [
        { runId: "active-1", status: "running" },
        { runId: "done", status: "completed" },
        { runId: "quiet-active", status: "stale" },
        { runId: "active-2", status: "running" },
      ],
      stop,
    );
    expect(stop).toHaveBeenCalledWith("active-1");
    expect(stop).toHaveBeenCalledWith("quiet-active");
    expect(stop).toHaveBeenCalledWith("active-2");
    expect(stop).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ attempted: ["active-1", "quiet-active", "active-2"], failed: [] });
  });

  it("continues after one run cannot be stopped", async () => {
    const stop = vi.fn(async (runId: string) => {
      if (runId === "bad") throw new Error("not found");
    });
    await expect(stopRunningSubagentRuns(
      [{ runId: "bad", status: "running" }, { runId: "good", status: "running" }],
      stop,
    )).resolves.toEqual({ attempted: ["bad", "good"], failed: ["bad"] });
  });
});
