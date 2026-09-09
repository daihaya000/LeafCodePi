import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { noProjectSessionDir, samePath, storePath } from "./paths";
import { NO_PROJECT_NAME, type ProjectDto, type TaskStatus, type TaskSummary, type ThinkingLevel } from "./types";

type StoreFile = {
  version: 1;
  projects: ProjectDto[];
  tasks: TaskSummary[];
};

/** SSE snapshots read the same store repeatedly; recheck disk only twice/sec. */
const STORE_CACHE_CHECK_MS = 500;
let cachedStore: {
  file: string;
  value: StoreFile;
  mtimeMs: number;
  size: number;
  checkedAt: number;
} | null = null;

function emptyStore(): StoreFile {
  return { version: 1, projects: [], tasks: [] };
}

function readStore(): StoreFile {
  const file = storePath();
  const now = Date.now();
  if (cachedStore?.file === file && now - cachedStore.checkedAt < STORE_CACHE_CHECK_MS) {
    return cachedStore.value;
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch {
    if (cachedStore?.file === file) cachedStore = null;
    return emptyStore();
  }
  if (
    cachedStore?.file === file &&
    cachedStore.mtimeMs === stat.mtimeMs &&
    cachedStore.size === stat.size
  ) {
    cachedStore.checkedAt = now;
    return cachedStore.value;
  }
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
      cachedStore = null;
      return emptyStore();
    }
    cachedStore = {
      file,
      value: parsed,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      checkedAt: now,
    };
    return parsed;
  } catch {
    cachedStore = null;
    return emptyStore();
  }
}

/** Keep a week of daily snapshots: one bad write repeated all day cannot erase the last good day. */
const STORE_BACKUP_DAYS = 7;

function snapshotStore(file: string): void {
  const directory = join(dirname(file), "backups");
  const name = `store-${new Date().toISOString().slice(0, 10)}.json`;
  mkdirSync(directory, { recursive: true });
  const target = join(directory, name);
  try {
    copyFileSync(file, target, 1 /* COPYFILE_EXCL: the first write of the day wins */);
  } catch {
    return; // Nothing to snapshot yet, or today is already covered.
  }
  const stale = readdirSync(directory)
    .filter((entry) => entry.startsWith("store-") && entry.endsWith(".json"))
    .sort()
    .slice(0, -STORE_BACKUP_DAYS);
  for (const entry of stale) rmSync(join(directory, entry), { force: true });
}

function writeStore(store: StoreFile): void {
  const file = storePath();
  mkdirSync(dirname(file), { recursive: true });
  snapshotStore(file);
  // Write then rename so a crash or a full disk can never leave a truncated store.
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  cachedStore = { file, value: store, mtimeMs: -1, size: -1, checkedAt: Date.now() };
}

export function listProjects(includeArchived = false): ProjectDto[] {
  const projects = readStore().projects;
  return includeArchived ? projects : projects.filter((project) => !project.archived);
}

export function getProject(id: string): ProjectDto | undefined {
  return readStore().projects.find((project) => project.id === id);
}

export function upsertProject(input: {
  name?: string;
  rootPath: string;
  favorite?: boolean;
}): ProjectDto {
  const store = readStore();
  const existing = store.projects.find((project) => samePath(project.rootPath, input.rootPath));
  const now = new Date().toISOString();
  if (existing) {
    existing.lastOpenedAt = now;
    existing.archived = false;
    if (typeof input.favorite === "boolean") existing.favorite = input.favorite;
    writeStore(store);
    return existing;
  }
  const project: ProjectDto = {
    id: randomUUID(),
    name: input.name?.trim() || "Untitled",
    rootPath: input.rootPath,
    favorite: input.favorite === true,
    archived: false,
    createdAt: now,
    lastOpenedAt: now,
  };
  store.projects.push(project);
  writeStore(store);
  return project;
}

export function patchProject(
  id: string,
  patch: Partial<Pick<ProjectDto, "name" | "favorite" | "archived" | "lastOpenedAt" | "icon">>,
): ProjectDto | undefined {
  const store = readStore();
  const project = store.projects.find((item) => item.id === id);
  if (!project) return undefined;
  Object.assign(project, patch);
  writeStore(store);
  return project;
}

export function listTasks(includeArchived = false, kind: "code" | "bot" = "code"): TaskSummary[] {
  const tasks = readStore().tasks.filter((task) => (task.kind ?? "code") === kind);
  return includeArchived ? tasks : tasks.filter((task) => task.status !== "archived");
}

export function insertBotTask(input: {
  id: string; botId: string; name: string; directory: string;
  model?: string | null; thinkingLevel?: ThinkingLevel | null;
  permissionMode?: "allow" | "ask" | "deny" | null;
}): TaskSummary {
  const store = readStore();
  const existing = store.tasks.find((task) => task.id === input.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const task: TaskSummary = {
    id: input.id, projectId: null, projectName: "Bots", title: input.name,
    directory: input.directory, isolation: "current_folder", status: "idle",
    sessionId: null, sessionFile: null, kind: "bot", botId: input.botId,
    ...(input.model ? { modelID: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    createdAt: now, updatedAt: now, error: null,
  };
  store.tasks.unshift(task);
  writeStore(store);
  return task;
}

export function getTask(id: string): TaskSummary | undefined {
  return readStore().tasks.find((task) => task.id === id);
}

export function insertTask(input: {
  project: ProjectDto | null;
  title: string;
  thinkingLevel?: ThinkingLevel;
  providerID?: string;
  modelID?: string;
  accountId?: string;
  accountIdExplicit?: boolean;
  botId?: string;
  agent?: string;
  skillPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
}): TaskSummary {
  const store = readStore();
  const now = new Date().toISOString();
  const task: TaskSummary = {
    id: randomUUID(),
    projectId: input.project?.id ?? null,
    projectName: input.project?.name ?? NO_PROJECT_NAME,
    title: input.title,
    directory: input.project?.rootPath ?? noProjectSessionDir(),
    isolation: "current_folder",
    status: "idle",
    sessionId: null,
    sessionFile: null,
    providerID: input.providerID,
    modelID: input.modelID,
    thinkingLevel: input.thinkingLevel,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.accountId && input.accountIdExplicit
      ? { accountIdExplicit: true }
      : {}),
    ...(input.botId ? { botId: input.botId } : {}),
    ...(input.skillPermission ? { skillPermission: input.skillPermission } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    createdAt: now,
    updatedAt: now,
    error: null,
  };
  store.tasks.unshift(task);
  writeStore(store);
  return task;
}

export function patchTask(
  id: string,
  patch: Partial<
    Pick<
      TaskSummary,
      | "title"
      | "projectId"
      | "projectName"
      | "directory"
      | "status"
      | "sessionId"
      | "sessionFile"
      | "providerID"
      | "modelID"
      | "thinkingLevel"
      | "accountId"
      | "accountIdExplicit"
      | "skillPermission"
      | "permissionMode"
      | "revertLeafId"
      | "manualAbortedAssistantId"
      | "hangRetryCount"
      | "agent"
      | "error"
    >
  >,
): TaskSummary | undefined {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === id);
  if (!task) return undefined;
  // 同一値への再パッチ（agent_start→working の繰り返し等）はディスク書き込みを
  // 起こさない。updatedAt も不変のまま（実変更が無いため並び順は変わらない）。
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if ((task as Record<string, unknown>)[key] !== value) {
      (task as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  if (!changed) return task;
  // Monotonic guard: two real changes within the same millisecond must still
  // advance updatedAt (preserves ordering and keeps the store-test's
  // same-millisecond writes deterministic).
  const previous = task.updatedAt;
  let next = new Date().toISOString();
  if (previous && next <= previous) {
    const ms = Date.parse(previous) + 1;
    next = new Date(ms).toISOString();
  }
  task.updatedAt = next;
  writeStore(store);
  return task;
}

export function setTaskStatus(id: string, status: TaskStatus, error?: string | null): TaskSummary | undefined {
  return patchTask(id, { status, error: error ?? null });
}

export function deleteTask(id: string): boolean {
  const store = readStore();
  const index = store.tasks.findIndex((task) => task.id === id);
  if (index < 0) return false;
  store.tasks.splice(index, 1);
  writeStore(store);
  return true;
}

export function deleteTasksByProject(projectId: string): number {
  const store = readStore();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((task) => task.projectId !== projectId);
  writeStore(store);
  return before - store.tasks.length;
}

export function deleteProjectRecord(id: string): boolean {
  const store = readStore();
  const index = store.projects.findIndex((project) => project.id === id);
  if (index < 0) return false;
  store.projects.splice(index, 1);
  writeStore(store);
  return true;
}
