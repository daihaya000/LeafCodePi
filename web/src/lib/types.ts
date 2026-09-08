export type TaskStatus = "working" | "ready" | "idle" | "error" | "archived" | "unknown";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const NO_PROJECT_NAME = "プロジェクトなし";

export type BotSkillsConfig = {
  mode: "inherit" | "include" | "exclude";
  include: string[];
  exclude: string[];
};

export type RoomConversationTurn = { requestId: string; participantIds: string[]; turn: number; maxTurns: number };
/** Why an exchange stopped, so a quiet room is not mistaken for a finished one. */
export type RoomOutcome = { kind: "code-wait" | "members" | "turns" | "repeat" | "done"; requestId: string };
export type CodeRequestState = "starting" | "running" | "ready" | "delivered" | "cancelled";
export type RoomAttention = { botId: string; taskId: string; permission: PermissionRequestDto | null; question: QuestionRequestDto | null };
/** Attachment stored beside the room file; `file` is server-generated and served by the images route. */
export type RoomImage = { file: string; mimeType: string };

export type RoomMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  images?: RoomImage[];
  botId?: string;
  botName?: string;
  status?: "working" | "done" | "error";
  /** Server-owned request/turn correlation, also persisted in delegated Code receipts. */
  conversation?: RoomConversationTurn;
  codeRequestId?: string;
  codeTaskId?: string | null;
  codeState?: CodeRequestState;
  /** What the delegated Code run is doing right now (tool label only, never its output). */
  codeActivity?: string;
};

export type RoomDto = {
  id: string;
  name: string;
  members: string[];
  /** Operator opt-in: this room's Code requests skip the per-request approval prompt. */
  codeAutoApprove?: boolean;
  lastOutcome?: RoomOutcome;
  createdAt: string;
  updatedAt: string;
  messages: RoomMessage[];
};
export type RoutineDto = {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  failureCount: number;
  lastRunAt: string | null;
};

export type BotDto = {
  id: string;
  name: string;
  label: string;
  avatarColor: string;
  /** アップロードされたアバター画像（data URL）。未設定ならnullでavatarColorのSVGにフォールバック。 */
  avatarImage: string | null;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  permissionMode: "allow" | "ask" | "deny" | null;
  skills: BotSkillsConfig;
  extraRoots: string[];
  enabled: boolean;
  /** Whether notifications for this bot are enabled in the Bot UI. */
  notificationsEnabled: boolean;
  /** The Code task currently controlled by this Bot, when one is linked. */
  codeSessionTaskId?: string | null;
  soul: string;
};

export type ProjectDto = {
  id: string;
  name: string;
  rootPath: string;
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
  icon?: string | null;
};

export type TodoProgressDto = {
  completed: number;
  total: number;
};

export type TaskSummary = {
  id: string;
  kind?: "code" | "bot";
  botId?: string;
  projectId: string | null;
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
  /** このタスクで使う認証アカウント（docs/plans/multi-account.md）。未設定 = 既定（~/.pi/agent/auth.json）。 */
  accountId?: string;
  /** accountId がユーザー指定なら true。Auto で選ばれたアカウントは false。 */
  accountIdExplicit?: boolean;
  /** Composer からのスキル使用許可。未設定の旧タスクは許可扱い。 */
  skillPermission?: "allow" | "deny";
  /** このタスクのツール承認モード。未設定の旧タスクは Composer 既定。 */
  permissionMode?: "allow" | "ask" | "deny";
  /** 巻き戻し前の leaf。ある間は「復元」できる。 */
  revertLeafId?: string | null;
  /** 空文字は応答開始前の停止。再開ボタンの目印。 */
  manualAbortedAssistantId?: string | null;
  /** 直近のハング自動再開回数。セッション差し替え後も通知を残す。 */
  hangRetryCount?: number;
  /** pi-subagents agent running as the main session persona (null = default). */
  agent?: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  /** 直前の失敗がプロバイダー利用制限であることを示す一時的なUIヒント。 */
  limitError?: boolean;
  todoProgress?: TodoProgressDto;
  /** 左メニューで使う軽量な Goal Loop 進捗。詳細状態は TaskDetail.goalLoop に保持する。 */
  goalLoopSummary?: GoalLoopSummaryDto;
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
  /** 次のターン開始までの待機時間（秒）。 */
  cooldownSeconds: number;
  /** クールタイム終了時刻。待機不要なら null。 */
  nextTurnAt: string | null;
  forceFullRun: boolean;
  /** Auto agent selection is re-evaluated before every Goal Loop turn. */
  autoAgent?: boolean;
  turnCount: number;
  turnKind: "goal" | "verification";
  pauseReason: string;
  error: string;
  progress: GoalLoopProgress[];
  summary: string;
  evidence: string;
  blockedReason: string;
  rejectedClaims: number;
  /** 連続して結果JSONを読めなかったターン数。正常な結果で0に戻る。 */
  unreadableStreak: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalLoopSummaryDto = Pick<GoalLoopDto, "status" | "maxTurns" | "turnCount">;

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
  /** Provider / model the child runs on (latest assistant message). */
  provider?: string;
  model?: string;
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

export type UiDiagnostic = {
  type: string;
  timestamp?: number;
  error?: {
    name?: string;
    message: string;
    code?: string | number;
  };
  /** Provider transport details only; secrets, headers, and stacks are omitted. */
  details?: {
    configuredTransport?: string;
    fallbackTransport?: string;
    phase?: string;
    eventsEmitted?: boolean;
    requestBytes?: number;
  };
};

export type UiMessage = {
  id: string;
  role: "user" | "assistant" | "compaction";
  createdAt: number;
  parts: UiPart[];
  /** この応答を生成した認証アカウント（未設定 = 既定）。アカウント切替の履歴確認用。 */
  accountId?: string;
  /** ハング watchdog による自動再送 user メッセージ（UI 非表示）。 */
  hangRetry?: boolean;
  model?: string;
  provider?: string;
  error?: string;
  diagnostics?: UiDiagnostic[];
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
  /** このモデルを利用する認証アカウント（既定 = undefined）。
   *   Home のドロップダウンでアカウントをプロバイダ枠として分けるために使う。 */
  accountId?: string;
  accountLabel?: string;
  input?: string[];
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  /** CodexBar usage percent (0..100+) of the backing provider, when known. */
  codexbarUsedPercent?: number | null;
  /** Average CodexBar usage for an integrated provider, used for picker color only. */
  codexbarIntegratedUsedPercent?: number | null;
  /** True when the backing provider is near or at its rate limit. */
  codexbarLimited?: boolean;
  /** True when the provider hit its rate limit (usage >= 99.5%). */
  codexbarMaxed?: boolean;
  /** True when CodexBar is showing a last-good snapshot after a fetch failure. */
  codexbarStale?: boolean;
  /** Integrated account routing hides the backing account labels in the picker. */
  routingMode?: "integrated";
  /** Number of authenticated account candidates behind an integrated option. */
  routingCandidateCount?: number;
};

export type HealthDto = {
  ok: boolean;
  engine: "pi";
  engineOk: boolean;
  version: string | null;
  modelCount: number;
  dataDir: string;
  error?: string | null;
  /** Non-fatal provider sync issues from the last model list refresh. */
  warnings?: string[];
};

export type ProviderAuthDto = {
  id: string;
  name: string;
  authenticated: boolean;
  accountRoutingMode?: "integrated" | "separate";
  methods?: ("api_key" | "oauth")[];
  authSource?: string;
  authLabel?: string;
  subscription?: boolean;
  oauthAvailable?: boolean;
  highlighted?: boolean;
  error?: string;
  /** API URL を変更できるプロバイダーのみ、現在有効な base URL。 */
  baseUrl?: string;
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
  permissionRequest?: PermissionRequestDto | null;
  questionRequest?: QuestionRequestDto | null;
  /** Empty string means abort before any assistant message existed. */
  manualAbortedAssistantId?: string | null;
  hangRetryCount?: number;
};

export type PermissionRequestDto = {
  id: string;
  sessionId: string;
  command: string;
  labels: string[];
  message: string;
};

export type QuestionOptionDto = {
  label: string;
  description?: string;
};

export type QuestionInfoDto = {
  question: string;
  header?: string;
  options: QuestionOptionDto[];
  multiple?: boolean;
  /** 自由入力を無効化する場合のみ false。 */
  custom?: boolean;
};

export type QuestionRequestDto = {
  id: string;
  sessionId: string;
  questions: QuestionInfoDto[];
};

/** タスク横断の注意喚起（GlobalAttentionProvider 用ポーリング応答）。 */
export type AttentionItemDto = {
  taskId: string;
  title: string;
  kinds: ("permission" | "question")[];
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
  /** count=1 モード時のみ: status porcelain の行数（files は空）。 */
  count?: number;
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
