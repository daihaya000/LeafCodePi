import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("store", () => {
  it("round-trips a project and task", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const { upsertProject, insertTask, listProjects, listTasks } = await import("./store");
    const project = upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    insertTask({ project, title: "hello", botId: "bot-1" });
    expect(listProjects()).toHaveLength(1);
    expect(listTasks()[0]).toMatchObject({ title: "hello", botId: "bot-1" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-adding an archived project restores it", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    const project = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });

    store.patchProject(project.id, { archived: true });
    expect(store.listProjects()).toHaveLength(0);

    const reopened = store.upsertProject({ name: "demo", rootPath: "C:\\tmp\\demo" });
    expect(reopened.id).toBe(project.id);
    expect(reopened.archived).toBe(false);
    expect(store.listProjects()).toHaveLength(1);
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

    const explicit = store.insertTask({
      project,
      title: "explicit account",
      accountId: "acc-1",
      accountIdExplicit: true,
    });
    expect(store.getTask(explicit.id)?.accountIdExplicit).toBe(true);
    store.patchTask(explicit.id, { accountIdExplicit: undefined });
    expect(store.getTask(explicit.id)?.accountIdExplicit).toBeUndefined();

    // patch で切替・既定への復帰ができる
    store.patchTask(withAccount.id, { accountId: "acc-2" });
    expect(store.getTask(withAccount.id)?.accountId).toBe("acc-2");
    store.patchTask(withAccount.id, { accountId: undefined });
    expect(store.getTask(withAccount.id)?.accountId).toBeUndefined();

    store.patchTask(withAccount.id, { revertLeafId: "leaf-tip" });
    expect(store.getTask(withAccount.id)?.revertLeafId).toBe("leaf-tip");
    store.patchTask(withAccount.id, { revertLeafId: null });
    expect(store.getTask(withAccount.id)?.revertLeafId).toBeNull();

    store.patchTask(withAccount.id, { manualAbortedAssistantId: "" });
    expect(store.getTask(withAccount.id)?.manualAbortedAssistantId).toBe("");
    store.patchTask(withAccount.id, { manualAbortedAssistantId: null });
    expect(store.getTask(withAccount.id)?.manualAbortedAssistantId).toBeNull();

    store.patchTask(withAccount.id, { hangRetryCount: 2 });
    expect(store.getTask(withAccount.id)?.hangRetryCount).toBe(2);
    store.patchTask(withAccount.id, { hangRetryCount: 0 });
    expect(store.getTask(withAccount.id)?.hangRetryCount).toBe(0);

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

  it("keeps the first daily snapshot so repeated bad writes cannot erase it", async () => {
    const dir = join(tmpdir(), `leafcode-pi-test-${Date.now()}-backup`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const store = await import("./store");
    store.upsertProject({ name: "one", rootPath: "C:\\tmp\\one" });
    store.upsertProject({ name: "two", rootPath: "C:\\tmp\\two" });
    const snapshot = join(dir, "backups", `store-${new Date().toISOString().slice(0, 10)}.json`);
    const names = () =>
      (JSON.parse(readFileSync(snapshot, "utf8")).projects as { name: string }[]).map((p) => p.name);

    expect(names()).toEqual(["one"]);
    store.upsertProject({ name: "three", rootPath: "C:\\tmp\\three" });
    expect(names()).toEqual(["one"]);
    expect(existsSync(`${join(dir, "store.json")}.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
