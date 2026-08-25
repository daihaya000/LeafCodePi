import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("store", () => {
  it("round-trips a project and task", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const { upsertProject, insertTask, listProjects, listTasks } = await import("./store");
    const project = upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    insertTask({ project, title: "hello" });
    expect(listProjects()).toHaveLength(1);
    expect(listTasks()[0]?.title).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives, restores, deletes and destroys tasks and projects", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    const project = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    const task = store.insertTask({ project, title: "t1" });
    const task2 = store.insertTask({ project, title: "t2" });

    // Archive then restore
    store.patchTask(task.id, { status: "archived" });
    expect(store.listTasks().find((t) => t.id === task.id)).toBeUndefined();
    expect(store.listTasks(true).find((t) => t.id === task.id)?.status).toBe("archived");

    // destroy one, restore the other
    store.deleteTask(task.id);
    expect(store.getTask(task.id)).toBeUndefined();
    store.patchTask(task2.id, { status: "archived" });
    store.patchTask(task2.id, { status: "idle" });
    expect(store.listTasks().find((t) => t.id === task2.id)?.status).toBe("idle");

    // deleteTasksByProject
    expect(store.deleteTasksByProject(project.id)).toBe(1);
    expect(store.listTasks(true)).toHaveLength(0);

    // deleteProjectRecord
    store.deleteProjectRecord(project.id);
    expect(store.getProject(project.id)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips the disk write when patching the same values", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    const project = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    const task = store.insertTask({ project, title: "t1" });

    store.setTaskStatus(task.id, "working");
    const first = statSync(join(dir, "store.json")).mtimeMs;

    // 同一値への再パッチはディスクへ書き込まない。
    store.setTaskStatus(task.id, "working");
    expect(statSync(join(dir, "store.json")).mtimeMs).toBe(first);

    // 実変更時は書き込む。
    store.setTaskStatus(task.id, "idle");
    expect(statSync(join(dir, "store.json")).mtimeMs).toBeGreaterThan(first);
    rmSync(dir, { recursive: true, force: true });
  });
});
