import { createPendingSnapshotStore } from "@backend-core/pending-snapshot-store.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { pendingSnapshots } from "./pending-snapshots";

describe("pendingSnapshots", () => {
  afterEach(() => {
    for (const entry of pendingSnapshots.list()) pendingSnapshots.clear(entry.taskId);
  });

  it("starts empty and records the last snapshot per task", () => {
    expect(pendingSnapshots.size).toBe(0);
    expect(pendingSnapshots.record("task-1", { eventType: "agent_start" })).toBe(true);
    expect(pendingSnapshots.read("task-1")).toEqual({
      taskId: "task-1",
      eventType: "agent_start",
      extra: undefined,
      isDelta: false,
    });
    pendingSnapshots.record("task-1", { eventType: "message_update", isDelta: true });
    expect(pendingSnapshots.read("task-1")?.eventType).toBe("message_update");
    expect(pendingSnapshots.read("task-1")?.isDelta).toBe(true);
    expect(pendingSnapshots.size).toBe(1);
  });

  it("is the same store object for every importer", async () => {
    pendingSnapshots.record("task-2", { eventType: "agent_settled" });
    const again = await import("./pending-snapshots");
    expect(again.pendingSnapshots).toBe(pendingSnapshots);
    expect(again.pendingSnapshots.read("task-2")?.eventType).toBe("agent_settled");
  });

  it("keeps the process-local copy independent from a fresh store", () => {
    const other = createPendingSnapshotStore({ limit: 512 });
    pendingSnapshots.record("task-3", { eventType: "agent_start" });
    expect(other.read("task-3")).toBeNull();
    expect(pendingSnapshots.read("task-3")?.eventType).toBe("agent_start");
  });
});
