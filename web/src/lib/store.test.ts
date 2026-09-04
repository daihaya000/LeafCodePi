import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
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

  it("creates an isolated no-project task workspace", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    const workspaceRoot = join(dir, "workspaces");
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    process.env.LEAFCODE_PI_DEFAULT_DIR = workspaceRoot;
    const store = await import("./store");
    const task = store.insertTask({ project: null, title: "temporary" });

    expect(task.projectId).toBeNull();
    expect(task.projectName).toBe("プロジェクトなし");
    expect(task.directory).toBeTruthy();
    expect(task.directory.startsWith(workspaceRoot)).toBe(true);
    expect(store.getTask(task.id)?.directory).toBe(task.directory);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.LEAFCODE_PI_DEFAULT_DIR;
  });

  it("persists and patches the task account", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    const project = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });

    // accountId 無し = 既定（~/.pi/agent/auth.json）
    const plain = store.insertTask({ project, title: "default" });
    expect(plain.accountId).toBeUndefined();

    const withAccount = store.insertTask({
      project,
      title: "with account",
      accountId: "acc-1",
    });
    expect(store.getTask(withAccount.id)?.accountId).toBe("acc-1");

    // patch で切替・既定への復帰ができる
    store.patchTask(withAccount.id, { accountId: "acc-2" });
    expect(store.getTask(withAccount.id)?.accountId).toBe("acc-2");
    store.patchTask(withAccount.id, { accountId: undefined });
    expect(store.getTask(withAccount.id)?.accountId).toBeUndefined();

    store.patchTask(withAccount.id, { revertLeafId: "leaf-tip" });
    expect(store.getTask(withAccount.id)?.revertLeafId).toBe("leaf-tip");
    store.patchTask(withAccount.id, { revertLeafId: null });
    expect(store.getTask(withAccount.id)?.revertLeafId).toBeNull();

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
    const first = store.getTask(task.id)!.updatedAt;

    // 同一値への再パッチは updatedAt を変えず、ディスク書き込みも起こさない。
    store.setTaskStatus(task.id, "working");
    expect(store.getTask(task.id)!.updatedAt).toBe(first);

    // 実変更時は updatedAt が更新される。
    store.setTaskStatus(task.id, "idle");
    expect(store.getTask(task.id)!.updatedAt).not.toBe(first);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores permissionMode on the task without sharing a global default", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    const project = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    const denied = store.insertTask({ project, title: "deny-task", permissionMode: "deny" });
    const allowed = store.insertTask({ project, title: "allow-task", permissionMode: "allow" });
    expect(store.getTask(denied.id)?.permissionMode).toBe("deny");
    expect(store.getTask(allowed.id)?.permissionMode).toBe("allow");
    store.patchTask(denied.id, { permissionMode: "ask" });
    expect(store.getTask(denied.id)?.permissionMode).toBe("ask");
    expect(store.getTask(allowed.id)?.permissionMode).toBe("allow");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores skillPermission on the task without sharing a global default", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    const project = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    const denied = store.insertTask({ project, title: "deny-skills", skillPermission: "deny" });
    const allowed = store.insertTask({ project, title: "allow-skills", skillPermission: "allow" });
    expect(store.getTask(denied.id)?.skillPermission).toBe("deny");
    expect(store.getTask(allowed.id)?.skillPermission).toBe("allow");
    store.patchTask(denied.id, { skillPermission: "allow" });
    expect(store.getTask(denied.id)?.skillPermission).toBe("allow");
    expect(store.getTask(allowed.id)?.skillPermission).toBe("allow");
    rmSync(dir, { recursive: true, force: true });
  });
});
