import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ activeGoalLoopTaskIds: vi.fn() }));
vi.mock("@/lib/pi/harness", () => ({
  activeGoalLoopTaskIds: mocks.activeGoalLoopTaskIds,
}));

import { GET } from "./route";

describe("GET /api/goal-loop/active", () => {
  it("returns the active goal loop task ids", async () => {
    mocks.activeGoalLoopTaskIds.mockReturnValue(["task-1", "task-2"]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: 2,
      taskIds: ["task-1", "task-2"],
    });
  });

  it("returns an empty list when nothing is running", async () => {
    mocks.activeGoalLoopTaskIds.mockReturnValue([]);
    const response = await GET();
    expect(await response.json()).toEqual({ active: 0, taskIds: [] });
  });
});