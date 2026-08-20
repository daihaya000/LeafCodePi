export type TaskStatus = "working" | "idle" | "error" | "archived" | "unknown";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ProjectDto = {
  id: string;
  name: string;
  rootPath: string;
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
};

export type TaskSummary = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  directory: string;
  isolation: "current_folder";
  status: TaskStatus;
  sessionId: string | null;
  sessionFile: string | null;
  providerID?: string;
  modelID?: string;
  thinkingLevel?: ThinkingLevel;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
};

export type ToolState = {
  status: "pending" | "running" | "completed" | "cancelled" | "error";
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
};

export type UiPart =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "thinking"; text: string }
  | {
      id: string;
      type: "tool";
      tool: string;
      callID: string;
      state: ToolState;
    }
  | { id: string; type: "image"; url: string; mime: string; filename?: string };

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  parts: UiPart[];
  model?: string;
  provider?: string;
  error?: string;
};

export type ModelOption = {
  value: string;
  label: string;
  providerID: string;
  modelID: string;
  input?: string[];
};

export type HealthDto = {
  ok: boolean;
  engine: "pi";
  engineOk: boolean;
  version: string | null;
  modelCount: number;
  dataDir: string;
  error?: string | null;
};

export type ProviderAuthDto = {
  id: string;
  name: string;
  authenticated: boolean;
  error?: string;
};

export type TaskDetail = TaskSummary & {
  messages: UiMessage[];
  isStreaming: boolean;
};
