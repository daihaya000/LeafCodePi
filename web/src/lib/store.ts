import { AppStore } from "@backend-core/app-store.mjs";
import { noProjectSessionDir, samePath, storePath } from "./paths";
import { NO_PROJECT_NAME } from "./types";

export type { TaskKind } from "@backend-core/app-store.mjs";

// Compatibility entrypoint. Keep path policy/test safety in the existing adapter,
// and preserve the original module-local cache lifetime and synchronous API.
const store = new AppStore({ storePath, noProjectSessionDir, samePath, noProjectName: NO_PROJECT_NAME });

export const listProjects = store.listProjects.bind(store);
export const getProject = store.getProject.bind(store);
export const upsertProject = store.upsertProject.bind(store);
export const patchProject = store.patchProject.bind(store);
export const listTasks = store.listTasks.bind(store);
export const insertBotTask = store.insertBotTask.bind(store);
export const getTask = store.getTask.bind(store);
export const insertTask = store.insertTask.bind(store);
export const patchTask = store.patchTask.bind(store);
export const setTaskStatus = store.setTaskStatus.bind(store);
export const deleteTask = store.deleteTask.bind(store);
export const deleteTasksByProject = store.deleteTasksByProject.bind(store);
export const deleteProjectRecord = store.deleteProjectRecord.bind(store);
