import type { ProjectDto, TaskSummary, TaskStatus, ThinkingLevel } from "@shared/types";

export type TaskKind = "code" | "bot" | "all";
export type ProjectPatch = Partial<Pick<ProjectDto, "name" | "rootPath" | "favorite" | "archived" | "lastOpenedAt" | "icon" | "iconColor">>;
export type TaskPatch = Partial<Pick<TaskSummary,
  | "title" | "titleAutoUpdate" | "label" | "projectId" | "projectName" | "directory"
  | "status" | "sessionId" | "sessionFile" | "providerID" | "modelID" | "thinkingLevel"
  | "accountId" | "accountIdExplicit" | "supervisorBotId" | "skillPermission" | "permissionMode"
  | "revertLeafId" | "manualAbortedAssistantId" | "hangRetryCount" | "agent" | "error"
>>;
export type InsertTaskInput = {
  project: ProjectDto | null;
  title: string;
  label?: string;
  thinkingLevel?: ThinkingLevel;
  providerID?: string;
  modelID?: string;
  accountId?: string;
  accountIdExplicit?: boolean;
  botId?: string;
  agent?: string;
  skillPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
};
export type InsertBotTaskInput = {
  id: string; botId: string; name: string; directory: string;
  model?: string | null; thinkingLevel?: ThinkingLevel | null;
  permissionMode?: "allow" | "ask" | "deny" | null;
};

export class AppStore {
  constructor(options: {
    storePath: () => string;
    noProjectSessionDir: () => string;
    samePath: (left: string, right: string) => boolean;
    noProjectName: string;
    now?: () => Date;
    uuid?: () => string;
  });
  listProjects(includeArchived?: boolean): ProjectDto[];
  getProject(id: string): ProjectDto | undefined;
  upsertProject(input: { name?: string; rootPath: string; favorite?: boolean }): ProjectDto;
  patchProject(id: string, patch: ProjectPatch): ProjectDto | undefined;
  listTasks(includeArchived?: boolean, kind?: TaskKind): TaskSummary[];
  insertBotTask(input: InsertBotTaskInput): TaskSummary;
  getTask(id: string): TaskSummary | undefined;
  insertTask(input: InsertTaskInput): TaskSummary;
  patchTask(id: string, patch: TaskPatch, options?: { preserveUpdatedAt?: boolean }): TaskSummary | undefined;
  setTaskStatus(id: string, status: TaskStatus, error?: string | null): TaskSummary | undefined;
  deleteTask(id: string): boolean;
  deleteTasksByProject(projectId: string): number;
  deleteProjectRecord(id: string): boolean;
}
