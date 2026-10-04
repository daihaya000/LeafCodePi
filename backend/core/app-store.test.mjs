import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppStore } from "./app-store.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-backend-app-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let file = join(root, "store.json");
  let time = Date.parse("2026-09-01T12:00:00.000Z");
  let ids = 0;
  let workspaces = 0;
  const backupErrors = [];
  const options = {
    storePath: () => file,
    noProjectSessionDir: () => {
      const directory = join(root, `workspace-${++workspaces}`);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
    noProjectName: "プロジェクトなし",
    onBackupError: (error) => backupErrors.push(error),
    now: () => new Date(time),
    uuid: () => `id-${++ids}`,
  };
  return {
    root, store: new AppStore(options), options, backupErrors,
    file: () => file, setFile: (value) => { file = value; },
    setTime: (value) => { time = value; },
    read: () => JSON.parse(readFileSync(file, "utf8")),
  };
}

test("construction starts no path, filesystem, clock or UUID work", () => {
  const fail = () => { throw new Error("must remain lazy"); };
  new AppStore({ storePath: fail, noProjectSessionDir: fail, samePath: fail, noProjectName: "none", now: fail, uuid: fail });
});

test("project/task CRUD preserves v1 format, Unicode, settings and recreation", (t) => {
  const f = fixture(t);
  const project = f.store.upsertProject({ name: " メカ😀 ", rootPath: "C:/Work", favorite: true });
  const task = f.store.insertTask({
    project, title: "モデル確認", label: "render", thinkingLevel: "high", providerID: "p", modelID: "m",
    accountId: "account", accountIdExplicit: true, botId: "bot", agent: "reviewer",
    skillPermission: "deny", permissionMode: "ask",
  });
  assert.equal(project.name, "メカ😀");
  assert.equal(task.directory, project.rootPath);
  assert.equal(task.accountIdExplicit, true);
  assert.equal(task.kind, undefined);
  assert.equal(f.read().version, 1);
  assert.equal(readFileSync(f.file(), "utf8"), `${JSON.stringify(f.read(), null, 2)}\n`);
  const restarted = new AppStore(f.options);
  assert.deepEqual(restarted.getTask(task.id), f.read().tasks[0]);
  assert.deepEqual(restarted.getProject(project.id), project);
  assert.equal(existsSync(`${f.file()}.tmp`), false);
});

test("path policy is injected and reopening preserves the existing project identity/name", (t) => {
  const f = fixture(t);
  const project = f.store.upsertProject({ name: "first", rootPath: "C:/Work", favorite: true });
  project.name = "caller mutation";
  assert.equal(f.store.getProject(project.id).name, "first");
  const patched = f.store.patchProject(project.id, { archived: true, icon: "folder", iconColor: "blue" });
  assert.notEqual(patched, project);
  patched.name = "caller mutation";
  assert.equal(f.store.getProject(project.id).name, "first");
  assert.deepEqual(f.store.listProjects(), []);
  const reopened = f.store.upsertProject({ name: "ignored", rootPath: "c:/work", favorite: false });
  assert.notEqual(reopened, project);
  assert.equal(reopened.id, project.id);
  assert.equal(project.favorite, true);
  assert.equal(reopened.archived, false);
  assert.equal(reopened.name, "first");
  assert.equal(reopened.favorite, false);
  assert.equal(reopened.iconColor, "blue");
  const listed = f.store.listProjects(true);
  listed[0].name = "list mutation";
  listed.splice(0, listed.length);
  assert.equal(f.store.getProject(project.id).name, "first");
  assert.equal(f.store.listProjects(true).length, 1);
});

test("no-project workspaces are isolated by the injected allocator", (t) => {
  const f = fixture(t);
  const a = f.store.insertTask({ project: null, title: "a" });
  const b = f.store.insertTask({ project: null, title: "b", accountIdExplicit: true });
  assert.notEqual(a.directory, b.directory);
  assert.equal(existsSync(a.directory), true);
  assert.equal(a.projectName, "プロジェクトなし");
  assert.equal(b.accountIdExplicit, undefined);
  assert.deepEqual(f.store.listTasks().map((task) => task.id), [b.id, a.id]);
});

test("legacy Code filtering, Bot deduplication and archive visibility remain unchanged", (t) => {
  const f = fixture(t);
  const code = f.store.insertTask({ project: null, title: "Code" });
  const bot = f.store.insertBotTask({ id: "bot:one", botId: "one", name: "Bot", directory: f.root, model: "p::m", thinkingLevel: "low", permissionMode: "deny" });
  const before = readFileSync(f.file(), "utf8");
  const duplicate = f.store.insertBotTask({ id: bot.id, botId: "one", name: "ignored", directory: "ignored" });
  assert.notEqual(duplicate, bot);
  assert.deepEqual(duplicate, bot);
  assert.equal(readFileSync(f.file(), "utf8"), before);
  assert.deepEqual(f.store.listTasks().map((task) => task.id), [code.id]);
  assert.deepEqual(f.store.listTasks(false, "bot").map((task) => task.id), [bot.id]);
  f.store.setTaskStatus(bot.id, "archived");
  assert.deepEqual(f.store.listTasks(false, "all").map((task) => task.id), [code.id]);
  assert.deepEqual(f.store.listTasks(true, "all").map((task) => task.id), [bot.id, code.id]);
});

test("no-op patches skip writes, real patches advance time and metadata can preserve time", (t) => {
  const f = fixture(t);
  const task = f.store.insertTask({ project: null, title: "test" });
  const originalTime = task.updatedAt;
  const firstStat = statSync(f.file());
  const unchanged = f.store.patchTask(task.id, { title: "test" });
  assert.notEqual(unchanged, task);
  assert.deepEqual(unchanged, task);
  unchanged.title = "caller mutation";
  assert.equal(f.store.getTask(task.id).title, "test");
  assert.equal(statSync(f.file()).mtimeMs, firstStat.mtimeMs);
  assert.equal(existsSync(join(f.root, "backups")), false);
  const working = f.store.setTaskStatus(task.id, "working");
  assert.equal(working.updatedAt, new Date(Date.parse(originalTime) + 1).toISOString());
  assert.equal(task.updatedAt, originalTime);
  const changedTime = working.updatedAt;
  const preserved = f.store.patchTask(task.id, { label: "classified", accountId: "new", hangRetryCount: 2 }, { preserveUpdatedAt: true });
  assert.equal(preserved.updatedAt, changedTime);
  const updated = f.store.patchTask(task.id, { accountId: undefined, permissionMode: "allow", manualAbortedAssistantId: "" });
  assert.equal(updated.accountId, undefined);
  assert.ok(updated.updatedAt > changedTime);
  assert.equal("accountId" in f.read().tasks[0], false);
});

test("a same-size, same-mtime replacement (a restore tool) is still noticed by the read cache", (t) => {
  const f = fixture(t);
  f.store.insertTask({ project: null, title: "aaaa" });
  // A whole-second timestamp can be restored exactly, like a backup tool that preserves mtime.
  utimesSync(f.file(), 1_700_000_000, 1_700_000_000);
  assert.equal(f.store.listTasks()[0].title, "aaaa");
  const before = statSync(f.file());
  const replacement = readFileSync(f.file(), "utf8").replace("aaaa", "bbbb");
  assert.equal(Buffer.byteLength(replacement), before.size);
  const temporary = `${f.file()}.restore`;
  writeFileSync(temporary, replacement, "utf8");
  renameSync(temporary, f.file());
  utimesSync(f.file(), 1_700_000_000, 1_700_000_000);
  assert.equal(statSync(f.file()).mtimeMs, before.mtimeMs);
  assert.equal(statSync(f.file()).size, before.size);
  assert.equal(f.store.listTasks()[0].title, "bbbb");
});

test("delete operations return the same counts and do not delete workspaces", (t) => {
  const f = fixture(t);
  const project = f.store.upsertProject({ rootPath: f.root });
  const a = f.store.insertTask({ project, title: "a" });
  f.store.insertTask({ project, title: "b" });
  const independent = f.store.insertTask({ project: null, title: "independent" });
  assert.equal(f.store.deleteTask("missing"), false);
  assert.equal(f.store.deleteTask(a.id), true);
  assert.equal(f.store.deleteTasksByProject(project.id), 1);
  assert.equal(f.store.deleteProjectRecord(project.id), true);
  assert.equal(f.store.deleteProjectRecord(project.id), false);
  assert.equal(existsSync(independent.directory), true);
  assert.equal(f.store.getTask(a.id), undefined);
});

test("successive writes keep numbered snapshots with bounded daily and date retention", (t) => {
  const f = fixture(t);
  for (const name of ["first", "second", "third", "fourth", "fifth", "sixth"]) {
    f.store.upsertProject({ name, rootPath: name });
  }
  const backupDirectory = join(f.root, "backups");
  const firstDay = readdirSync(backupDirectory).sort();
  assert.deepEqual(firstDay, [
    "store-2026-09-01-000001.json",
    "store-2026-09-01-000003.json",
    "store-2026-09-01-000004.json",
    "store-2026-09-01-000005.json",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(backupDirectory, firstDay[0]), "utf8")).projects.map((project) => project.name), ["first"]);
  assert.deepEqual(JSON.parse(readFileSync(join(backupDirectory, firstDay.at(-1)), "utf8")).projects.map((project) => project.name), ["first", "second", "third", "fourth", "fifth"]);

  for (let day = 2; day <= 10; day += 1) {
    f.setTime(Date.parse(`2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`));
    f.store.upsertProject({ rootPath: `day-${day}` });
  }
  const retained = readdirSync(backupDirectory).sort();
  assert.equal(retained.length, 7);
  assert.equal(retained[0], "store-2026-09-04-000001.json");
  assert.equal(retained.at(-1), "store-2026-09-10-000001.json");
});

test("backup failures are reported without blocking a valid store update", (t) => {
  const f = fixture(t);
  const project = f.store.upsertProject({ name: "before", rootPath: "before" });
  writeFileSync(join(f.root, "backups"), "not a directory", "utf8");

  assert.doesNotThrow(() => f.store.patchProject(project.id, { name: "after" }));
  assert.equal(f.store.getProject(project.id).name, "after");
  assert.equal(f.backupErrors.length, 1);
  assert.match(f.backupErrors[0].message, /application store backup failed/);
});

test("cached read DTOs are detached, external changes are seen and storage roots remain isolated", (t) => {
  const f = fixture(t);
  const task = f.store.insertTask({ project: null, title: "before" });
  task.title = "mutated insert result";
  assert.equal(f.store.getTask(task.id).title, "before");
  const read = f.store.getTask(task.id);
  assert.notEqual(read, task);
  read.title = "mutated read";
  f.store.listTasks()[0].title = "mutated list";
  assert.equal(f.store.getTask(task.id).title, "before");
  const disk = f.read();
  disk.tasks[0].title = "from external writer with a different file size";
  writeFileSync(f.file(), `${JSON.stringify(disk, null, 2)}\n`, "utf8");
  assert.equal(f.store.getTask(task.id).title, disk.tasks[0].title);
  const firstFile = f.file();
  f.setFile(join(f.root, "other", "store.json"));
  assert.deepEqual(f.store.listTasks(), []);
  f.store.insertTask({ project: null, title: "second root" });
  f.setFile(firstFile);
  assert.equal(f.store.getTask(task.id).title, disk.tasks[0].title);
});

test("missing, corrupt and unsupported files return an empty store without eager rewrites", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.listProjects(), []);
  assert.equal(existsSync(f.file()), false);
  for (const text of ["{invalid", JSON.stringify({ version: 2, projects: [], tasks: [] }), JSON.stringify({ version: 1, projects: [], tasks: null })]) {
    writeFileSync(f.file(), text, "utf8");
    assert.deepEqual(f.store.listTasks(), []);
    assert.equal(readFileSync(f.file(), "utf8"), text);
  }
});

test("mutations refuse to overwrite corrupt or unsupported store files", (t) => {
  const f = fixture(t);
  for (const text of ["{invalid", "", JSON.stringify({ version: 2, projects: [], tasks: [] }), JSON.stringify({ version: 1, projects: [], tasks: null })]) {
    writeFileSync(f.file(), text, "utf8");
    assert.throws(() => f.store.insertTask({ project: null, title: "must not persist" }), /refusing to overwrite/);
    assert.throws(() => f.store.upsertProject({ name: "p", rootPath: "C:/Work" }), /refusing to overwrite/);
    assert.equal(readFileSync(f.file(), "utf8"), text);
  }
  rmSync(f.file());
  assert.equal(f.store.upsertProject({ name: "p", rootPath: "C:/Work" }).name, "p");
});

test("a failed mutation leaves the previous destination and read cache intact", (t) => {
  const f = fixture(t);
  const task = f.store.insertTask({ project: null, title: "before" });
  const before = readFileSync(f.file(), "utf8");
  f.store.now = () => { throw new Error("injected write preparation failure"); };
  assert.throws(() => f.store.patchTask(task.id, { title: "after" }));
  assert.equal(readFileSync(f.file(), "utf8"), before);
  assert.equal(f.store.getTask(task.id).title, "before");
  assert.equal(existsSync(`${f.file()}.lock`), false);
});

test("a plain Node process can read and update the same v1 store without Web/SDK imports", (t) => {
  const f = fixture(t);
  const task = f.store.insertTask({ project: null, title: "before" });
  const moduleUrl = new URL("./app-store.mjs", import.meta.url).href;
  const code = `
    import { AppStore } from ${JSON.stringify(moduleUrl)};
    const store = new AppStore({
      storePath: () => ${JSON.stringify(f.file())}, noProjectSessionDir: () => ${JSON.stringify(f.root)},
      samePath: (a, b) => a === b, noProjectName: "none",
    });
    const task = store.patchTask(${JSON.stringify(task.id)}, { title: "別プロセス😀" });
    console.log(JSON.stringify({ title: task.title }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), { title: "別プロセス😀" });
  assert.equal(f.store.getTask(task.id).title, "別プロセス😀");
});
