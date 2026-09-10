import { describe, expect, it } from "vitest";
import {
  sameHealth,
  sameProjectList,
  sameTaskList,
  reorderProjectIds,
  tasksForSidebar,
  latestWorkingTask,
} from "./Sidebar";
import type { GoalLoopSummaryDto, HealthDto, ProjectDto, TaskSummary } from "@/lib/types";

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

  it("detects a Bot attribution change", () => {
    expect(
      sameTaskList([task("t1", "working", "タスクA")], [{ ...task("t1", "working", "タスクA"), botId: "bot-1" }]),
    ).toBe(false);
  });

  it("detects goal loop progress changes", () => {
    const loop: GoalLoopSummaryDto = { status: "running", maxTurns: 10, turnCount: 1 };
    const a = [{ ...task("t1", "working", "タスクA"), goalLoopSummary: loop }];
    const b = [{ ...a[0], goalLoopSummary: { ...loop, turnCount: 2 } }];
    expect(sameTaskList(a, b)).toBe(false);
  });
});

describe("tasksForSidebar", () => {
  it("prioritizes working conversations, then sorts each group by latest update", () => {
    const tasks: TaskSummary[] = [
      { ...task("t1", "idle", "アイドル"), updatedAt: "2026-01-01T00:04:00.000Z" },
      { ...task("t2", "working", "進行中A"), updatedAt: "2026-01-01T00:01:00.000Z" },
      { ...task("t3", "error", "エラー"), updatedAt: "2026-01-01T00:03:00.000Z" },
      { ...task("t4", "working", "進行中B"), updatedAt: "2026-01-01T00:02:00.000Z" },
    ];
    expect(tasksForSidebar(tasks).map((item) => item.title)).toEqual([
      "進行中B",
      "進行中A",
      "アイドル",
      "エラー",
    ]);
  });

  it("returns empty list unchanged", () => {
    expect(tasksForSidebar([])).toEqual([]);
  });
});

describe("latestWorkingTask", () => {
  it("returns the newest working task for the requested project", () => {
    const newest = task("t2", "working", "進行中の最新タスク");
    const tasks = [
      newest,
      task("t1", "working", "進行中の古いタスク"),
      task("other", "working", "別プロジェクト"),
    ].map((item) => (item.id === "other" ? { ...item, projectId: "p2" } : item));

    expect(latestWorkingTask(tasks, "p1")).toEqual(newest);
  });

  it("selects the newest working task even when the API list is insertion-ordered", () => {
    const older = { ...task("t1", "working", "進行中の古いタスク"), updatedAt: "2026-01-01T00:01:00.000Z" };
    const newer = { ...task("t2", "working", "進行中の最新タスク"), updatedAt: "2026-01-01T00:02:00.000Z" };

    expect(latestWorkingTask([older, newer], "p1")).toEqual(newer);
  });

  it("returns null when the project has no working task", () => {
    expect(latestWorkingTask([task("t1", "idle", "完了済み")], "p1")).toBeNull();
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
