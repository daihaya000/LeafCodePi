import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.mjs";

const STORE_BACKUP_DAYS = 7;
const emptyStore = () => ({ version: 1, projects: [], tasks: [] });

/** Application CRUD and disk format, independent of SDK, Next and path settings. */
export class AppStore {
  #cachedStore = null;

  constructor({ storePath, noProjectSessionDir, samePath, noProjectName, now = () => new Date(), uuid = () => randomUUID() }) {
    this.storePath = storePath;
    this.noProjectSessionDir = noProjectSessionDir;
    this.samePath = samePath;
    this.noProjectName = noProjectName;
    this.now = now;
    this.uuid = uuid;
  }

  #mutate(update) {
    return withFileLock(this.storePath(), () => {
      try {
        this.#readStore(true);
        return update();
      } catch (error) {
        this.#cachedStore = null;
        throw error;
      }
    });
  }

  #readStore(fresh = false) {
    const file = this.storePath();
    let stat;
    try { stat = statSync(file); }
    catch {
      if (this.#cachedStore?.file === file) this.#cachedStore = null;
      return emptyStore();
    }
    if (!fresh && this.#cachedStore?.file === file && this.#cachedStore.mtimeMs === stat.mtimeMs && this.#cachedStore.size === stat.size) {
      return this.#cachedStore.value;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
        this.#cachedStore = null;
        return emptyStore();
      }
      if (this.#cachedStore?.file === file && JSON.stringify(this.#cachedStore.value) === JSON.stringify(parsed)) {
        this.#cachedStore.mtimeMs = stat.mtimeMs;
        this.#cachedStore.size = stat.size;
        return this.#cachedStore.value;
      }
      this.#cachedStore = { file, value: parsed, mtimeMs: stat.mtimeMs, size: stat.size };
      return parsed;
    } catch {
      this.#cachedStore = null;
      return emptyStore();
    }
  }

  #snapshotStore(file) {
    const directory = join(dirname(file), "backups");
    const name = `store-${this.now().toISOString().slice(0, 10)}.json`;
    mkdirSync(directory, { recursive: true });
    try { copyFileSync(file, join(directory, name), 1 /* COPYFILE_EXCL */); }
    catch { return; }
    // Preserve the first snapshot of each day and retain seven daily snapshots.
    const stale = readdirSync(directory)
      .filter((entry) => entry.startsWith("store-") && entry.endsWith(".json"))
      .sort().slice(0, -STORE_BACKUP_DAYS);
    for (const entry of stale) rmSync(join(directory, entry), { force: true });
  }

  #writeStore(store) {
    const file = this.storePath();
    mkdirSync(dirname(file), { recursive: true });
    this.#snapshotStore(file);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
    let mtimeMs = -1;
    let size = -1;
    try {
      const stat = statSync(file);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch { /* sentinel values force the next read to refresh */ }
    this.#cachedStore = { file, value: store, mtimeMs, size };
  }

  listProjects(includeArchived = false) {
    const projects = this.#readStore().projects;
    return includeArchived ? projects.slice() : projects.filter((project) => !project.archived);
  }

  getProject(id) { return this.#readStore().projects.find((project) => project.id === id); }

  upsertProject(input) { return this.#mutate(() => this.#upsertProject(input)); }

  #upsertProject(input) {
    const store = this.#readStore();
    const existing = store.projects.find((project) => this.samePath(project.rootPath, input.rootPath));
    const now = this.now().toISOString();
    if (existing) {
      existing.lastOpenedAt = now;
      existing.archived = false;
      if (typeof input.favorite === "boolean") existing.favorite = input.favorite;
      this.#writeStore(store);
      return existing;
    }
    const project = {
      id: this.uuid(), name: input.name?.trim() || "Untitled", rootPath: input.rootPath,
      favorite: input.favorite === true, archived: false, createdAt: now, lastOpenedAt: now,
    };
    store.projects.push(project);
    this.#writeStore(store);
    return project;
  }

  patchProject(id, patch) { return this.#mutate(() => this.#patchProject(id, patch)); }

  #patchProject(id, patch) {
    const store = this.#readStore();
    const project = store.projects.find((item) => item.id === id);
    if (!project) return undefined;
    Object.assign(project, patch);
    this.#writeStore(store);
    return project;
  }

  listTasks(includeArchived = false, kind = "code") {
    const tasks = this.#readStore().tasks.filter((task) => kind === "all" || (task.kind ?? "code") === kind);
    return includeArchived ? tasks : tasks.filter((task) => task.status !== "archived");
  }

  insertBotTask(input) { return this.#mutate(() => this.#insertBotTask(input)); }

  #insertBotTask(input) {
    const store = this.#readStore();
    const existing = store.tasks.find((task) => task.id === input.id);
    if (existing) return existing;
    const now = this.now().toISOString();
    const task = {
      id: input.id, projectId: null, projectName: "Bots", title: input.name,
      directory: input.directory, isolation: "current_folder", status: "idle",
      sessionId: null, sessionFile: null, kind: "bot", botId: input.botId,
      ...(input.model ? { modelID: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      createdAt: now, updatedAt: now, error: null,
    };
    store.tasks.unshift(task);
    this.#writeStore(store);
    return task;
  }

  getTask(id) { return this.#readStore().tasks.find((task) => task.id === id); }

  insertTask(input) { return this.#mutate(() => this.#insertTask(input)); }

  #insertTask(input) {
    const store = this.#readStore();
    const now = this.now().toISOString();
    const task = {
      id: this.uuid(), projectId: input.project?.id ?? null,
      projectName: input.project?.name ?? this.noProjectName, title: input.title,
      ...(input.label ? { label: input.label } : {}),
      directory: input.project?.rootPath ?? this.noProjectSessionDir(),
      isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
      providerID: input.providerID, modelID: input.modelID, thinkingLevel: input.thinkingLevel,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.accountId && input.accountIdExplicit ? { accountIdExplicit: true } : {}),
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.skillPermission ? { skillPermission: input.skillPermission } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      createdAt: now, updatedAt: now, error: null,
    };
    store.tasks.unshift(task);
    this.#writeStore(store);
    return task;
  }

  patchTask(id, patch, options = {}) { return this.#mutate(() => this.#patchTask(id, patch, options)); }

  #patchTask(id, patch, options) {
    const store = this.#readStore();
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return undefined;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (task[key] !== value) { task[key] = value; changed = true; }
    }
    if (!changed) return task;
    if (!options.preserveUpdatedAt) {
      const previous = task.updatedAt;
      let next = this.now().toISOString();
      if (previous && next <= previous) next = new Date(Date.parse(previous) + 1).toISOString();
      task.updatedAt = next;
    }
    this.#writeStore(store);
    return task;
  }

  setTaskStatus(id, status, error) { return this.patchTask(id, { status, error: error ?? null }); }

  deleteTask(id) { return this.#mutate(() => this.#deleteTask(id)); }

  #deleteTask(id) {
    const store = this.#readStore();
    const index = store.tasks.findIndex((task) => task.id === id);
    if (index < 0) return false;
    store.tasks.splice(index, 1);
    this.#writeStore(store);
    return true;
  }

  deleteTasksByProject(projectId) { return this.#mutate(() => this.#deleteTasksByProject(projectId)); }

  #deleteTasksByProject(projectId) {
    const store = this.#readStore();
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((task) => task.projectId !== projectId);
    this.#writeStore(store);
    return before - store.tasks.length;
  }

  deleteProjectRecord(id) { return this.#mutate(() => this.#deleteProjectRecord(id)); }

  #deleteProjectRecord(id) {
    const store = this.#readStore();
    const index = store.projects.findIndex((project) => project.id === id);
    if (index < 0) return false;
    store.projects.splice(index, 1);
    this.#writeStore(store);
    return true;
  }
}
