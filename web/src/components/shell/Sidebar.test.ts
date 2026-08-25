import { describe, expect, it } from "vitest";
import {
  sameHealth,
  sameProjectList,
  sameRooms,
  sameTaskList,
  reorderProjectIds,
} from "./Sidebar";
import type { HealthDto, ProjectDto, TaskSummary } from "@/lib/types";
import type { CollaborationRoomSummary } from "@/lib/collaboration-room";

function task(id: string, status: TaskSummary["status"], title: string): TaskSummary {
  return {
    id,
    projectId: "p1",
    projectName: "プロジェクト",
    title,
    directory: "C:\\repo",
    isolation: "current_folder",
    status,
    sessionId: null,
    sessionFile: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
  };
}

function project(id: string, name: string): ProjectDto {
  return {
    id,
    name,
    rootPath: "C:\\repo",
    favorite: false,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  };
}

const healthy: HealthDto = {
  ok: true,
  engine: "pi",
  engineOk: true,
  version: "1.2.3",
  modelCount: 7,
  dataDir: "C:/data",
  error: null,
};

describe("sameTaskList", () => {
  it("detects identical lists across polls", () => {
    const a = [task("t1", "idle", "タスクA")];
    const b = [task("t1", "idle", "タスクA")];
    expect(sameTaskList(a, b)).toBe(true);
  });

  it("detects a status change", () => {
    expect(
      sameTaskList([task("t1", "idle", "タスクA")], [task("t1", "working", "タスクA")]),
    ).toBe(false);
  });

  it("detects todo progress changes", () => {
    const a = [task("t1", "idle", "タスクA")];
    const b = [{ ...task("t1", "idle", "タスクA"), todoProgress: { completed: 1, total: 2 } }];
    expect(sameTaskList(a, b)).toBe(false);
  });
});

describe("sameProjectList", () => {
  it("detects identical lists across polls", () => {
    expect(sameProjectList([project("p1", "A")], [project("p1", "A")])).toBe(true);
  });

  it("detects a favorite change", () => {
    expect(
      sameProjectList([project("p1", "A")], [{ ...project("p1", "A"), favorite: true }]),
    ).toBe(false);
  });
});

describe("reorderProjectIds", () => {
  it("moves an item before or after the target without mutating the source", () => {
    const ids = ["a", "b", "c"];

    expect(reorderProjectIds(ids, "a", "c")).toEqual(["b", "a", "c"]);
    expect(reorderProjectIds(ids, "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("rejects missing or identical project ids", () => {
    expect(reorderProjectIds(["a", "b"], "a", "a")).toBeNull();
    expect(reorderProjectIds(["a", "b"], "a", "missing")).toBeNull();
  });
});

describe("sameHealth", () => {
  it("detects identical snapshots", () => {
    expect(sameHealth(healthy, { ...healthy })).toBe(true);
  });

  it("returns false when previous is null", () => {
    expect(sameHealth(null, healthy)).toBe(false);
  });

  it("detects an engineOk change", () => {
    expect(sameHealth(healthy, { ...healthy, engineOk: false })).toBe(false);
  });
});

describe("sameRooms", () => {
  const room: CollaborationRoomSummary = {
    ready: true,
    peers: 1,
    sessionNames: ["A"],
    leaseConflicts: 0,
    pendingAsks: 0,
    epoch: 3,
  };

  it("detects identical rooms", () => {
    expect(sameRooms({ p1: room }, { p1: { ...room } })).toBe(true);
  });

  it("detects a peer change", () => {
    expect(sameRooms({ p1: room }, { p1: { ...room, peers: 2 } })).toBe(false);
  });

  it("detects a removed room", () => {
    expect(sameRooms({ p1: room }, {})).toBe(false);
  });
});
