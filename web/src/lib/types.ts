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

export type GoalLoopStatus =
  | "queued"
  | "running"
  | "paused"
  | "verifying_completed"
  | "completed"
  | "blocked"
  | "stopped";

export type GoalLoopProgress = {
  time: string;
  status: "progress" | "completed" | "verified_completed" | "blocked";
  summary: string;
  next?: string;
  evidence?: string;
};

export type GoalLoopDto = {
  id: string;
  sessionId: string;
  cwd: string;
  status: GoalLoopStatus;
  goal: string;
  acceptance: string[];
  maxTurns: number;
  forceFullRun: boolean;
  turnCount: number;
  turnKind: "goal" | "verification";
  pauseReason: string;
  error: string;
  progress: GoalLoopProgress[];
  summary: string;
  evidence: string;
  blockedReason: string;
  rejectedClaims: number;
  createdAt: string;
  updatedAt: string;
};

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export type TodoDto = {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
};

export type ToolState = {
  status: "pending" | "running" | "completed" | "cancelled" | "error";
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  /** Wall-clock start time of tool execution (ms epoch). */
  startedAtMs?: number;
  /** Wall-clock end time of tool execution (ms epoch). */
  endedAtMs?: number;
  /** pi-subagents run ids reported in the tool result details (subagent tool). */
  subagentRunIds?: string[];
};

/** One pi-subagents child run, projected from its transcript artifact. */
export type SubagentRunDto = {
  runId: string;
  agent: string;
  index?: number;
  status: "running" | "completed" | "error" | "stale";
  startedAtMs: number;
  lastActivityAtMs: number;
  /** Tool the child is currently running, when known. */
  currentTool: string | null;
  /** True when only the tail of a huge transcript was read. */
  truncated: boolean;
  messages: UiMessage[];
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
  role: "user" | "assistant" | "compaction";
  createdAt: number;
  parts: UiPart[];
  /** ハング watchdog による自動再送 user メッセージ（UI 非表示）。 */
  hangRetry?: boolean;
  model?: string;
  provider?: string;
  error?: string;
  /** Tokens estimated before this compaction (compaction role only). */
  tokensBefore?: number;
  /** Assistant output tokens used for tok/s (provider usage or live estimate). */
  outputTokens?: number;
  /** Generation throughput in tokens/sec for this assistant turn. */
  tokensPerSecond?: number;
  /** True when tokensPerSecond is decode-phase (excludes TTFT). */
  tokensPerSecondDecode?: boolean;
  /**
   * Approximate response window (previous record's timestamp → this
   * assistant message's timestamp) in ms. Shown as the "thinking" seconds in
   * the meta row, matching the upstream LeafCode display.
   */
  responseDurationMs?: number;
};

export type ModelOption = {
  value: string;
  label: string;
  providerID: string;
  modelID: string;
  input?: string[];
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
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
  methods?: ("api_key" | "oauth")[];
  authSource?: string;
  authLabel?: string;
  subscription?: boolean;
  oauthAvailable?: boolean;
  highlighted?: boolean;
  error?: string;
};

export type TaskDetail = TaskSummary & {
  messages: UiMessage[];
  isStreaming: boolean;
  /** True while manual or auto context compaction is running. */
  isCompacting?: boolean;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  goalLoop?: GoalLoopDto | null;
  todos?: TodoDto[];
};

export type DiffLine = {
  t: " " | "+" | "-";
  text: string;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type DiffFile = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  hunks: DiffHunk[];
  /** Last on-disk modification time (ISO), when the file still exists. */
  modifiedAt?: string;
};

export type DiffFilesPayload = {
  git: boolean;
  branch: string | null;
  /** Base ref this diff was computed against (merge-base compare), if any. */
  base?: string | null;
  files: DiffFile[];
  additions: number;
  deletions: number;
  error?: string;
};

/** One commit for the graph panel. */
export type GraphCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
};

export type GraphRef = {
  name: string;
  hash: string;
  current?: boolean;
};

export type GraphLogPayload = {
  commits: GraphCommit[];
  refs: GraphRef[];
  currentBranch: string | null;
  hasMore: boolean;
};

export type GraphFileChange = {
  path: string;
  status: "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";
};

export type GraphShowPayload = {
  commit: string;
  files?: GraphFileChange[];
  diff?: string;
};

export type CompactionSettingsDto = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};
