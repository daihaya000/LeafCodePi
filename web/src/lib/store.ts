import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { storePath } from "./paths";
import type { ProjectDto, TaskStatus, TaskSummary, ThinkingLevel } from "./types";

type StoreFile = {
  version: 1;
  projects: ProjectDto[];
  tasks: TaskSummary[];
};

function emptyStore(): StoreFile {
  return { version: 1, projects: [], tasks: [] };
}

function readStore(): StoreFile {
  try {
    const raw = readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: StoreFile): void {
  const file = storePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
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
  const existing = store.projects.find(
    (project) => project.rootPath.toLowerCase() === input.rootPath.toLowerCase(),
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.lastOpenedAt = now;
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
  patch: Partial<Pick<ProjectDto, "name" | "favorite" | "archived" | "lastOpenedAt">>,
): ProjectDto | undefined {
  const store = readStore();
  const project = store.projects.find((item) => item.id === id);
  if (!project) return undefined;
  Object.assign(project, patch);
  writeStore(store);
  return project;
}

export function listTasks(includeArchived = false): TaskSummary[] {
  const tasks = readStore().tasks;
  return includeArchived ? tasks : tasks.filter((task) => task.status !== "archived");
}

export function getTask(id: string): TaskSummary | undefined {
  return readStore().tasks.find((task) => task.id === id);
}

export function insertTask(input: {
  project: ProjectDto;
  title: string;
  thinkingLevel?: ThinkingLevel;
  providerID?: string;
  modelID?: string;
  agent?: string;
  skillPermission?: "allow" | "deny";
}): TaskSummary {
  const store = readStore();
  const now = new Date().toISOString();
  const task: TaskSummary = {
    id: randomUUID(),
    projectId: input.project.id,
    projectName: input.project.name,
    title: input.title,
    directory: input.project.rootPath,
    isolation: "current_folder",
    status: "idle",
    sessionId: null,
    sessionFile: null,
    providerID: input.providerID,
    modelID: input.modelID,
    thinkingLevel: input.thinkingLevel,
    ...(input.skillPermission ? { skillPermission: input.skillPermission } : {}),
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
      | "status"
      | "sessionId"
      | "sessionFile"
      | "providerID"
      | "modelID"
      | "thinkingLevel"
      | "skillPermission"
      | "agent"
      | "error"
    >
  >,
): TaskSummary | undefined {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === id);
  if (!task) return undefined;
  Object.assign(task, patch);
  task.updatedAt = new Date().toISOString();
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
