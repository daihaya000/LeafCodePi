import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.mjs";
import { assertConfigurationOwner } from "./configuration-command.mjs";

const STORE_BACKUP_DAYS = 7;
const STORE_BACKUP_GENERATIONS_PER_DAY = 4;
const emptyStore = () => ({ version: 1, projects: [], tasks: [] });
const cloneForCaller = (value) => value === undefined ? undefined : structuredClone(value);

/** Application CRUD and disk format, independent of SDK, Next and path settings. */
export class AppStore {
  #cachedStore = null;

  constructor({ storePath, noProjectSessionDir, samePath, noProjectName, now = () => new Date(), uuid = () => randomUUID(), onBackupError = (error) => process.emitWarning(error) }) {
    this.storePath = storePath;
    this.noProjectSessionDir = noProjectSessionDir;
    this.samePath = samePath;
    this.noProjectName = noProjectName;
    this.now = now;
    this.uuid = uuid;
    this.onBackupError = onBackupError;
  }

  #mutate(update) {
    return withFileLock(this.storePath(), () => {
      try {
        this.#readStore(true, true);
        return cloneForCaller(update());
      } catch (error) {
        this.#cachedStore = null;
        throw error;
      }
    });
  }

  /**
   * `strict` (mutations only): an existing file that cannot be interpreted throws instead of
   * yielding an empty store, so a transient/corrupt read never replaces real data on write.
   * A missing file is still a valid empty store.
   */
  #readStore(fresh = false, strict = false) {
    const file = this.storePath();
    let stat;
    try { stat = statSync(file); }
    catch (error) {
      if (this.#cachedStore?.file === file) this.#cachedStore = null;
      if (strict && error?.code !== "ENOENT") throw new Error(`store file could not be inspected; refusing to overwrite: ${file}`, { cause: error });
      return emptyStore();
    }
    if (!fresh && this.#cachedStore?.file === file && this.#cachedStore.mtimeMs === stat.mtimeMs && this.#cachedStore.size === stat.size
      && this.#cachedStore.ctimeMs === stat.ctimeMs && this.#cachedStore.ino === stat.ino) {
      return this.#cachedStore.value;
    }
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
        this.#cachedStore = null;
        if (strict) throw new Error(`store file has an unsupported format; refusing to overwrite: ${file}`);
        return emptyStore();
      }
      if (this.#cachedStore?.file === file && this.#cachedStore.raw === raw) {
        this.#cachedStore.mtimeMs = stat.mtimeMs;
        this.#cachedStore.size = stat.size;
        this.#cachedStore.ctimeMs = stat.ctimeMs;
        this.#cachedStore.ino = stat.ino;
        return this.#cachedStore.value;
      }
      // ctime/inode join mtime/size: a restore or copy tool that preserves mtime and size still changes them.
      this.#cachedStore = { file, value: parsed, mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, ino: stat.ino, raw };
      return parsed;
    } catch (error) {
      this.#cachedStore = null;
      if (strict) throw new Error(`store file could not be read; refusing to overwrite: ${file}`, { cause: error });
      return emptyStore();
    }
  }

  #snapshotStore(file) {
    const directory = join(dirname(file), "backups");
    try { statSync(file); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      this.#reportBackupError(file, error);
      return;
    }

    let backupPath;
    try {
      mkdirSync(directory, { recursive: true });
      const day = this.now().toISOString().slice(0, 10);
      const sequencePattern = new RegExp(`^store-${day}-(\\d+)\\.json$`);
      const sequence = readdirSync(directory)
        .map((entry) => Number(sequencePattern.exec(entry)?.[1] ?? 0))
        .reduce((maximum, value) => Math.max(maximum, value), 0) + 1;
      backupPath = join(directory, `store-${day}-${String(sequence).padStart(6, "0")}.json`);
      copyFileSync(file, backupPath, 1 /* COPYFILE_EXCL */);
    } catch (error) {
      if (backupPath) {
        try { rmSync(backupPath, { force: true }); } catch { /* preserve the primary store write */ }
      }
      this.#reportBackupError(file, error);
      return;
    }

    try { this.#pruneStoreBackups(directory); }
    catch (error) { this.#reportBackupError(file, error); }
  }

  #pruneStoreBackups(directory) {
    const snapshots = readdirSync(directory).flatMap((entry) => {
      const match = /^store-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/.exec(entry);
      return match ? [{ entry, day: match[1], sequence: Number(match[2] ?? 0) }] : [];
    });
    const days = [...new Set(snapshots.map((snapshot) => snapshot.day))].sort().slice(-STORE_BACKUP_DAYS);
    const retained = new Set();
    for (const day of days) {
      const generations = snapshots.filter((snapshot) => snapshot.day === day)
        .sort((left, right) => left.sequence - right.sequence || left.entry.localeCompare(right.entry));
      const recent = generations.length > STORE_BACKUP_GENERATIONS_PER_DAY
        ? [generations[0], ...generations.slice(-(STORE_BACKUP_GENERATIONS_PER_DAY - 1))]
        : generations;
      for (const snapshot of recent) retained.add(snapshot.entry);
    }
    for (const snapshot of snapshots) {
      if (!retained.has(snapshot.entry)) rmSync(join(directory, snapshot.entry), { force: true });
    }
  }

  #reportBackupError(file, error) {
    try { this.onBackupError(new Error(`application store backup failed: ${file}`, { cause: error })); }
    catch { /* backup reporting must not block the primary store write */ }
  }

  #writeStore(store) {
    const file = this.storePath();
    mkdirSync(dirname(file), { recursive: true });
    this.#snapshotStore(file);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const raw = `${JSON.stringify(store, null, 2)}\n`;
    try {
      writeFileSync(temp, raw, "utf8");
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
    let mtimeMs = -1;
    let size = -1;
    let ctimeMs = -1;
    let ino = -1;
    try {
      const stat = statSync(file);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
      ctimeMs = stat.ctimeMs;
      ino = stat.ino;
    } catch { /* sentinel values force the next read to refresh */ }
    this.#cachedStore = { file, value: store, mtimeMs, size, ctimeMs, ino, raw };
  }

  listProjects(includeArchived = false) {
    const projects = this.#readStore().projects;
    return cloneForCaller(includeArchived ? projects : projects.filter((project) => !project.archived));
  }

  getProject(id) { return cloneForCaller(this.#readStore().projects.find((project) => project.id === id)); }

  upsertProject(input) { assertConfigurationOwner(); return this.#mutate(() => this.#upsertProject(input)); }

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

  patchProject(id, patch) { assertConfigurationOwner(); return this.#mutate(() => this.#patchProject(id, patch)); }

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
    return cloneForCaller(includeArchived ? tasks : tasks.filter((task) => task.status !== "archived"));
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

  getTask(id) { return cloneForCaller(this.#readStore().tasks.find((task) => task.id === id)); }

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

  deleteProjectRecord(id) { assertConfigurationOwner(); return this.#mutate(() => this.#deleteProjectRecord(id)); }

  #deleteProjectRecord(id) {
    const store = this.#readStore();
    const index = store.projects.findIndex((project) => project.id === id);
    if (index < 0) return false;
    store.projects.splice(index, 1);
    this.#writeStore(store);
    return true;
  }
}
