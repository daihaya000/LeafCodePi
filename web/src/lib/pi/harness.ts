import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, isAbsolutePath } from "@/lib/paths";
import {
  deleteProjectRecord,
  deleteTask,
  getProject,
  getTask,
  insertTask,
  listProjects,
  listTasks,
  patchProject,
  patchTask,
  setTaskStatus,
  upsertProject,
} from "@/lib/store";
import {
  ProviderLoginSession,
  isHighlightedProvider,
  providerAuthMethods,
  type AuthTypeDto,
  type LoginSessionEvent,
} from "@/lib/pi/auth-login";
import {
  entryIdsForProjectedMessages,
  piRawMessageProjectsToUi,
  projectPiMessages,
  toolResultText,
  titleFromPrompt,
} from "@/lib/pi/messages";
import {
  buildProviderModelsCatalog,
  enabledModelOptionsFromCatalog,
  mergeIntegratedProviderRows,
  type ProviderModelsRow,
} from "@/lib/provider-models";
import {
  accountProviderModelKey,
  readProviderModelState,
  setProviderModelDisabled,
  setProviderModelOrder,
  sortByPreferredOrder,
} from "@/lib/provider-model-state";
import {
  registerLlamaProviders,
  syncLlamaServerProvider,
} from "@/lib/pi/llama-provider";
import { registerCursorProvider } from "@/lib/pi/cursor-provider";
import { registerCommandCodeProvider } from "@/lib/pi/commandcode-provider";
import {
  registerOllamaCloudProvider,
  syncOllamaCloudProvider,
} from "@/lib/pi/ollama-cloud-provider";
import { readGoalLoopState } from "@/lib/pi/goal-loop-state";
import {
  todoProgressFromTodos,
  todosFromPiMessages,
} from "@/lib/pi/todowrite-state";
import { toContextUsageDto, type ContextUsageDto } from "@/lib/context-usage";
import { filterSkillsByState } from "@/lib/skills";
import type { SkillPermission } from "@/lib/skill-permission";
import { sessionIdentityPatch } from "@/lib/pi/session-identity";
import {
  applyCollaborationToolPolicy,
  basenameKey,
  bundledExtensionEntries,
  filterExtensionsByState,
  LEAFCODE_COLLABORATION_EXTENSION_NAME,
  LEAFCODE_COLLABORATION_TOOL_NAMES,
} from "@/lib/extensions";
import { readCollaborationConfig } from "@/lib/collaboration";
import {
  applyPermissionMode,
  readPermissionGateConfig,
} from "@/lib/permission-gate-config";
import { buildAgentResourceOptions, loadAgentDefinition } from "@/lib/agents";
import {
  armTaskHangWatch,
  registerHangWatchdogHooks,
  startHangWatchdog,
} from "@/lib/pi/hang-watchdog";
import { HANG_RETRY_PREFIX } from "@/lib/hang-retry";
import {
  createPermissionPromptService,
  taskIdForSession,
} from "@/lib/pi/permission-prompt";
import { registerWebUiPermissionHandler } from "@/lib/pi/webui-permission-bridge";
import { AccountRuntimeManager } from "@/lib/pi/account-runtime-manager";
import {
  accountAuthPath,
  accountHasProvider,
  accountModelsStorePath,
  accountStoredProviders,
  getAccount,
  isAccountOnlyProvider,
  isAccountProviderId,
  listAccounts,
  resolvePiAgentDir,
  type AccountProviderId,
  type AccountRecord,
} from "@/lib/accounts";
import {
  createQuestionPromptService,
  type QuestionAnswer,
} from "@/lib/pi/question-prompt";
import { registerWebUiQuestionHandler } from "@/lib/pi/webui-question-bridge";
import { listSubagentRuns } from "@/lib/pi/subagent-runs";
import { stopRunningSubagentRuns } from "@/lib/pi/stop-subagent-runs";
import { getCachedUsage, invalidateCachedUsage } from "@/lib/codexbar/cache";
import type { CodexBarProvider } from "@/lib/codexbar";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import {
  accountRoutingMode,
  chooseRoutingCandidate,
  isAccountRoutingProvider,
  readProviderRouting,
  setAccountRoutingMode,
  type AccountRoutingMode,
  type RoutingCandidate,
} from "@/lib/provider-routing";

/** True when a skill lives under the user's ~/.agents directory. */
function isAgentsSkill(skill: {
  baseDir?: string;
  filePath?: string;
}): boolean {
  const agentsRoot = join(homedir(), ".agents");
  const lower = agentsRoot.toLowerCase();
  return (
    (skill.baseDir?.toLowerCase().startsWith(lower) ?? false) ||
    (skill.filePath?.toLowerCase().startsWith(lower) ?? false)
  );
}
import {
  clampThinkingLevelForModel,
  defaultThinkingLevel,
  isThinkingLevel,
  thinkingLevelsForModel,
} from "@/lib/thinking-levels";
import {
  THROUGHPUT_CUSTOM_TYPE,
  createThroughputTiming,
  isContentDeltaType,
  isThroughputCustomEntry,
  noteContentDelta,
  noteReportedOutputTokens,
  snapshotThroughput,
  timingFromPersisted,
  toPersistedThroughput,
  type ThroughputTiming,
} from "@/lib/token-throughput";
import type {
  CompactionSettingsDto,
  GoalLoopDto,
  GoalLoopSummaryDto,
  HealthDto,
  ModelOption,
  ProjectDto,
  ProviderAuthDto,
  PermissionRequestDto,
  QuestionRequestDto,
  AttentionItemDto,
  TaskDetail,
  TaskSummary,
  TodoDto,
  TodoProgressDto,
  ThinkingLevel,
  UiMessage,
} from "@/lib/types";

type PiModule = typeof import("@earendil-works/pi-coding-agent");

type AgentSession = Awaited<
  ReturnType<PiModule["createAgentSession"]>
>["session"];
type ModelRuntime = Awaited<ReturnType<PiModule["ModelRuntime"]["create"]>>;
type Model = NonNullable<AgentSession["model"]>;

export type PromptImage = {
  mimeType: string;
  data: string;
};

/** High-frequency stream events — coalesce snapshot SSE instead of emitting every token. */
const THROTTLED_SNAPSHOT_EVENTS = new Set([
  "message_update",
  "tool_execution_update",
]);
const SNAPSHOT_THROTTLE_MS = 100;
/** These lifecycle events do not change anything rendered by TaskView. */
const NON_RENDERING_SESSION_EVENTS = new Set([
  "turn_start",
  "turn_end",
  "entry_appended",
]);

type LiveRuntime = {
  taskId: string;
  /** セッション生成時に使ったアカウント（null = 既定）。破棄時の参照解放に使う。 */
  accountId: string | null;
  /** メッセージID → 生成時の認証アカウント。セッション置き換え後も保持して過去の表示を守る。 */
  accountByMessageId: Map<string, string>;
  session: AgentSession;
  skillPermission: SkillPermission;
  skillPermissionRef: { current: SkillPermission };
  unsubscribe: () => void;
  promptChain: Promise<void>;
  /** A prompt has been accepted and is about to start or is still running. */
  promptActive: boolean;
  /** Assistant throughput samples keyed by message.timestamp (ms). */
  throughputByStartedAt: Map<number, ThroughputTiming>;
  /** startedAtMs values already written to the Pi session file. */
  persistedThroughputKeys: Set<number>;
  /** toolCallId → wall-clock start (ms) for live elapsed display. */
  toolStartedAt: Map<string, number>;
  /** toolCallId → wall-clock end (ms), set on tool_execution_end. */
  toolEndedAt: Map<string, number>;
  /** toolCallId → latest cumulative partial output while a tool is running. */
  toolPartialOutputByCallId: Map<string, string>;
  /** Coalesce message_update snapshots onto the event loop. */
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  pendingSnapshotEventType: string | null;
  /** Session entry id the last navigateTree moved the leaf to (for undo). */
  revertLeafId: string | null;
  /** POST /abort で中断したターンの assistant メッセージ ID。 */
  manualAbortedAssistantId: string | null;
  /** 直近のハング自動再開回数（UI 通知用）。 */
  hangRetryCount: number;
  /** 「Reasoning is mandatory」400 で思考 ON に上げて再試行済みか。 */
  reasoningFallbackTried: boolean;
};

type SessionSetup = {
  session: AgentSession;
  skillPermissionRef: { current: SkillPermission };
};

type HarnessState = {
  pi: PiModule | null;
  modelRuntime: ModelRuntime | null;
  /** アカウント別ランタイム（accountId → runtime）。既定は上のシングルトン。 */
  accountRuntimes: AccountRuntimeManager | null;
  initError: string | null;
  initPromise: Promise<void> | null;
  live: Map<string, LiveRuntime>;
  events: EventEmitter;
  loginSession: ProviderLoginSession | null;
  healthCache: HealthCacheEntry | null;
  modelCache: ModelCacheEntry | null;
  modelInflight: Promise<ModelOption[]> | null;
  accountModelCache: AccountModelCacheEntry | null;
  accountModelInflight: AccountModelInflight | null;
  watchdogRegistered: boolean;
  lastProviderSyncWarnings: string[];
};

const GLOBAL_KEY = "__leafcodePiHarness" as const;

/** Coalesce concurrent ensureLive(taskId) so only one Pi session is created. */
const ensureLiveInflight = new Map<string, Promise<LiveRuntime>>();
/** Serialize selection + task insert for the same integrated provider/model. */
const routeLocks = new Map<string, Promise<void>>();
/** Reserve selected accounts until the new task has a live session. */
const routeReservations = new Map<string, Map<string, number>>();

function reserveRoute(providerID: string, accountId: string): void {
  const accounts =
    routeReservations.get(providerID) ?? new Map<string, number>();
  accounts.set(accountId, (accounts.get(accountId) ?? 0) + 1);
  routeReservations.set(providerID, accounts);
}

function releaseRoute(providerID: string, accountId: string): void {
  const accounts = routeReservations.get(providerID);
  if (!accounts) return;
  const remaining = (accounts.get(accountId) ?? 0) - 1;
  if (remaining > 0) accounts.set(accountId, remaining);
  else accounts.delete(accountId);
  if (accounts.size === 0) routeReservations.delete(providerID);
}

async function withRouteLock<T>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = routeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => current);
  routeLocks.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (routeLocks.get(key) === chain) routeLocks.delete(key);
  }
}

type SnapshotProjectionCache = {
  source: readonly unknown[];
  length: number;
  last: unknown;
  projected: UiMessage[];
};

type BranchProjectionCache = {
  leafId: string | null;
  raw: unknown[];
  entryIdByMessage: Map<unknown, string>;
  projected: UiMessage[];
};

/** Stable session history is reused between 100ms SSE snapshots. */
const snapshotProjectionCache = new WeakMap<object, SnapshotProjectionCache>();
/** Full current-branch history survives compaction and is reused between snapshots. */
const branchProjectionCache = new WeakMap<object, BranchProjectionCache>();

type ContextUsageCacheEntry = {
  source: readonly unknown[];
  length: number;
  last: unknown;
  value: ContextUsageDto | undefined;
};

/** getContextUsage() estimates tokens over all messages; skip it while messages are unchanged. */
const contextUsageCache = new WeakMap<object, ContextUsageCacheEntry>();

type TodoProgressCacheEntry = {
  mtimeMs: number;
  size: number;
  value: TodoProgressDto | undefined;
};

/** Reopen archived task session files only when they actually changed on disk. */
const todoProgressCache = new Map<string, TodoProgressCacheEntry>();

type PermissionPromptService = ReturnType<typeof createPermissionPromptService>;
let permissionPromptService: PermissionPromptService | null = null;

function resolveTaskIdFromSession(sessionId: string): string | null {
  return taskIdForSession(
    sessionId,
    [...state().live.values()].map((live) => ({
      taskId: live.taskId,
      sessionId: live.session.sessionId,
    })),
  );
}

function permissionSnapshotExtras(taskId: string): Record<string, unknown> {
  const live = state().live.get(taskId);
  const task = getTask(taskId);
  if (!live || !task) return {};
  return {
    task: toSummary(task),
    ...sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    ),
    manualAbortedAssistantId: live.manualAbortedAssistantId,
    hangRetryCount: live.hangRetryCount,
  };
}

function ensurePermissionPromptService(): PermissionPromptService {
  if (permissionPromptService) return permissionPromptService;
  permissionPromptService = createPermissionPromptService({
    resolveTaskId: resolveTaskIdFromSession,
    emit: (taskId, payload) => emit(taskId, payload),
    snapshotExtras: permissionSnapshotExtras,
  });
  registerWebUiPermissionHandler((request) =>
    permissionPromptService!.handleRequest(request),
  );
  return permissionPromptService;
}

type QuestionPromptService = ReturnType<typeof createQuestionPromptService>;
let questionPromptService: QuestionPromptService | null = null;

function ensureQuestionPromptService(): QuestionPromptService {
  if (questionPromptService) return questionPromptService;
  questionPromptService = createQuestionPromptService({
    resolveTaskId: resolveTaskIdFromSession,
    emit: (taskId, payload) => emit(taskId, payload),
    snapshotExtras: permissionSnapshotExtras,
  });
  registerWebUiQuestionHandler((request) =>
    questionPromptService!.handleRequest(request),
  );
  return questionPromptService;
}

function state(): HarnessState {
  const globalRef = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: HarnessState;
  };
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: null,
      accountRuntimes: null,
      initError: null,
      initPromise: null,
      live: new Map(),
      events: new EventEmitter(),
      loginSession: null,
      healthCache: null,
      modelCache: null,
      modelInflight: null,
      accountModelCache: null,
      accountModelInflight: null,
      watchdogRegistered: false,
      lastProviderSyncWarnings: [],
    };
    globalRef[GLOBAL_KEY].events.setMaxListeners(100);
  }
  return globalRef[GLOBAL_KEY];
}

function packageVersion(): string | null {
  try {
    const candidates = [
      join(
        process.cwd(),
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      ),
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      ),
    ];
    for (const pkgPath of candidates) {
      if (!existsSync(/* turbopackIgnore: true */ pkgPath)) continue;
      const pkg = JSON.parse(
        readFileSync(/* turbopackIgnore: true */ pkgPath, "utf8"),
      ) as { version?: string };
      if (pkg.version) return pkg.version;
    }
    return null;
  } catch {
    return null;
  }
}

async function loadPi(): Promise<PiModule> {
  const current = state();
  if (current.pi) return current.pi;
  current.pi = await import("@earendil-works/pi-coding-agent");
  return current.pi;
}

/**
 * タスク/クエリ由来の accountId に対応する ModelRuntime を解決する。
 * - 未指定 = 既定ランタイム（~/.pi/agent/auth.json のシングルトン）
 * - 指定時 = アカウント別認証ストレージ（~/.pi/agent/accounts/<id>/auth.json）の
 *   ランタイムを遅延生成して再利用する（docs/plans/multi-account.md Phase 6）。
 */
export async function getRuntimeFor(
  accountId?: string | null,
): Promise<ModelRuntime | null> {
  if (!accountId) return state().modelRuntime;
  if (!getAccount(accountId)) {
    throw Object.assign(new Error("アカウントが見つかりません"), {
      status: 404,
    });
  }
  try {
    return await accountRuntimeManager().ensure(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(`アカウントランタイムの初期化に失敗しました: ${message}`),
      { status: 503 },
    );
  }
}

/** アカウント別ランタイムの生成ファクトリ（生成時にプロバイダー登録まで行う）。 */
function accountRuntimeManager(): AccountRuntimeManager {
  const current = state();
  if (!current.accountRuntimes) {
    current.accountRuntimes = new AccountRuntimeManager(async (id) => {
      const pi = await loadPi();
      const agentDir = await resolvePiAgentDir();
      const authPath = accountAuthPath(id, agentDir);
      const runtime = await pi.ModelRuntime.create({
        authPath,
        modelsStorePath: accountModelsStorePath(id, agentDir),
        allowModelNetwork: true,
        modelRefreshTimeoutMs: 8_000,
      });
      await registerLlamaProviders(runtime);
      await ensureOptionalProviders(runtime, {
        key: `account:${id}`,
        kind: "account",
        accountId: id,
        accountLabel: getAccount(id)?.label ?? null,
        authPath,
      });
      return runtime;
    });
  }
  return current.accountRuntimes;
}

const OPTIONAL_PROVIDERS_KEY = "__leafcodePiOptionalProviders" as const;

async function ensureOptionalProviders(
  runtime: ModelRuntime,
  scope?: import("@/lib/codexbar/types").UsageScope,
): Promise<void> {
  const globalRef = globalThis as typeof globalThis & {
    [OPTIONAL_PROVIDERS_KEY]?: WeakMap<object, Promise<void>>;
  };
  const promises = (globalRef[OPTIONAL_PROVIDERS_KEY] ??= new WeakMap());
  const existing = promises.get(runtime);
  if (existing) return existing;
  const promise = (async () => {
    await registerCursorProvider(runtime, scope);
    await registerCommandCodeProvider(runtime, scope);
    await registerOllamaCloudProvider(runtime);
  })();
  promises.set(runtime, promise);
  try {
    await promise;
  } finally {
    if (promises.get(runtime) === promise) promises.delete(runtime);
  }
}

async function ensureRuntime(): Promise<void> {
  const current = state();
  if (!current.modelRuntime && !current.initPromise) {
    current.initPromise = (async () => {
      try {
        const pi = await loadPi();
        current.modelRuntime = await pi.ModelRuntime.create({
          allowModelNetwork: true,
          modelRefreshTimeoutMs: 8_000,
        });
        await registerLlamaProviders(current.modelRuntime);
        current.initError = null;
      } catch (error) {
        current.initError =
          error instanceof Error ? error.message : String(error);
        current.initPromise = null;
        throw error;
      }
    })();
  }
  if (current.initPromise) await current.initPromise;
  if (current.modelRuntime) {
    await ensureOptionalProviders(current.modelRuntime);
  }
  if (!current.watchdogRegistered) {
    current.watchdogRegistered = true;
    registerHangWatchdogHooks({
      getLive: (taskId) => {
        const live = current.live.get(taskId);
        if (!live) return null;
        return {
          isStreaming: live.session.isStreaming,
          isCompacting: live.session.isCompacting,
          messages: snapshotMessages(
            live.session,
            live.throughputByStartedAt,
            live.toolStartedAt,
            live.toolEndedAt,
            live.toolPartialOutputByCallId,
            false,
            { accountId: live.accountId, byMessageId: live.accountByMessageId },
          ),
        };
      },
      abortTask: async (taskId) => {
        const live = current.live.get(taskId);
        if (live) {
          const msgs = snapshotMessages(
            live.session,
            live.throughputByStartedAt,
            live.toolStartedAt,
            live.toolEndedAt,
            live.toolPartialOutputByCallId,
            false,
            { accountId: live.accountId, byMessageId: live.accountByMessageId },
          );
          let promptIndex = -1;
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i]?.role === "user") {
              promptIndex = i;
              break;
            }
          }
          const turnAssistants =
            promptIndex >= 0
              ? msgs
                  .slice(promptIndex + 1)
                  .filter((m) => m.role === "assistant")
              : [];
          live.manualAbortedAssistantId = turnAssistants.at(-1)?.id ?? "";
          await stopSubagentRunsForTask(live, msgs);
          await live.session.abort();
        }
        setTaskStatus(taskId, "idle");
      },
      resumePrompt: (taskId, input) => {
        const live = current.live.get(taskId);
        if (!live) return;
        queuePrompt(live, input.prompt, input.images, {
          agent: input.agent,
          subagentPermission: input.subagentPermission,
          permissionMode: input.permissionMode,
          isHangRetry: true,
        });
      },
      notifyHangRetry: (taskId, retryCount) => {
        const live = current.live.get(taskId);
        if (!live) return;
        live.hangRetryCount = retryCount;
        emitTaskSnapshot(live, "hang_retry", { hangRetryCount: retryCount });
      },
    });
    startHangWatchdog();
  }
  ensurePermissionPromptService();
}

function modelValue(providerID: string, modelID: string): string {
  return `${providerID}::${modelID}`;
}

type ParsedModelValue = {
  accountId?: string;
  providerID: string;
  modelID: string;
};

function parseModelValue(value: string | undefined): ParsedModelValue | null {
  if (!value) return null;
  const parts = value.split("::");
  // 先頭セグメントが登録済みアカウントIDのときだけアカウント付き値として扱う。
  // モデルID側に "::" が含まれる共有値を誤って分割しないためのガード。
  if (parts.length >= 3 && parts[0] && parts[1] && parts.slice(2).join("::")) {
    if (getAccount(parts[0])) {
      return {
        accountId: parts[0],
        providerID: parts[1],
        modelID: parts.slice(2).join("::"),
      };
    }
  }
  const separator = value.indexOf("::");
  if (separator <= 0) return null;
  const providerID = value.slice(0, separator);
  const modelID = value.slice(separator + 2);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function modelId(model: Model | undefined): {
  providerID?: string;
  modelID?: string;
} {
  if (!model) return {};
  const record = model as unknown as Record<string, unknown>;
  const providerID = String(record.provider ?? record.providerID ?? "");
  const modelID = String(record.id ?? record.model ?? "");
  return {
    providerID: providerID || undefined,
    modelID: modelID || undefined,
  };
}

/** throughput timing をメッセージへ反映（tok/s + 実測の応答所要時間）。 */
export function applyThroughput(
  messages: UiMessage[],
  throughputByStartedAt: Map<number, ThroughputTiming>,
): UiMessage[] {
  if (throughputByStartedAt.size === 0) return messages;
  const nowMs = Date.now();
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const timing = throughputByStartedAt.get(message.createdAt);
    if (!timing) return message;
    // 応答全体の所要時間（思考＋生成、TTFT 込み）。Pi の assistant timestamp は
    // 生成「開始」時刻のため、直前レコードとの差分では常に 0s になる —
    // 実測 lastToken を使う（応答完了後は永続化された値で復元）。
    const responseDurationMs = Math.max(
      0,
      (timing.lastTokenAtMs ?? nowMs) - timing.startedAtMs,
    );
    const snap = snapshotThroughput(timing, nowMs);
    if (!snap || snap.tokensPerSecond === null) {
      return responseDurationMs > 0
        ? { ...message, responseDurationMs }
        : message;
    }
    return {
      ...message,
      outputTokens: snap.outputTokens,
      tokensPerSecond: snap.tokensPerSecond,
      tokensPerSecondDecode: snap.decodePhase,
      ...(responseDurationMs > 0 ? { responseDurationMs } : {}),
    };
  });
}

export type MessageAccountContext = {
  /** 現在のセッションアカウント（null = 既定）。 */
  accountId: string | null;
  /** 一度記録したメッセージのアカウント。セッション置き換え後も過去の値を保持する。 */
  byMessageId: Map<string, string>;
};

/** アシスタントメッセージへ生成時のアカウントを記録する（初回のみ記録、以降は保持）。 */
export function applyMessageAccountIds(
  messages: UiMessage[],
  context: MessageAccountContext,
): UiMessage[] {
  const { accountId, byMessageId } = context;
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let recorded = byMessageId.get(message.id);
    if (recorded === undefined && accountId) {
      recorded = accountId;
      byMessageId.set(message.id, recorded);
    }
    if (!recorded || message.accountId === recorded) return message;
    changed = true;
    return { ...message, accountId: recorded };
  });
  return changed ? result : messages;
}

export function snapshotMessages(
  session: AgentSession,
  throughputByStartedAt?: Map<number, ThroughputTiming>,
  toolStartedAt?: Map<string, number>,
  toolEndedAt?: Map<string, number>,
  toolPartialOutputByCallId?: Map<string, string>,
  latestOnly = false,
  accountContext?: MessageAccountContext,
): UiMessage[] {
  const stored: unknown[] = Array.isArray(session.messages)
    ? session.messages
    : [];
  const branchLeafId = session.sessionManager.getLeafId();
  const cachedBranch = branchProjectionCache.get(session);
  let useBranchHistory = false;
  let branchCacheHit = false;
  let historyRaw: unknown[] = stored;
  let entryIdByMessage = new Map<unknown, string>();

  if (cachedBranch?.leafId === branchLeafId) {
    useBranchHistory = true;
    branchCacheHit = true;
    historyRaw = cachedBranch.raw;
    entryIdByMessage = cachedBranch.entryIdByMessage;
  } else {
    const branch = session.sessionManager.getBranch();
    if (branch.length > 0) {
      useBranchHistory = true;
      entryIdByMessage = new Map<unknown, string>();
      historyRaw = branch.flatMap((entry) => {
        if (entry.type === "message") {
          entryIdByMessage.set(entry.message, entry.id);
          return [entry.message];
        }
        if (entry.type !== "compaction") return [];
        const timestamp = Date.parse(entry.timestamp);
        return [
          {
            id: entry.id,
            role: "compactionSummary" as const,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
          },
        ];
      });
    }
  }
  const streaming = session.agent.state.streamingMessage;
  const streamingInHistory = useBranchHistory
    ? entryIdByMessage.has(streaming)
    : stored.includes(streaming);
  const streamingRole =
    streaming && typeof streaming === "object"
      ? (streaming as { role?: unknown }).role
      : undefined;
  const canAppendStreaming = Boolean(
    streaming && !streamingInHistory && streamingRole !== "toolResult",
  );

  const projectWithEntryIds = (
    raw: unknown[],
    indexOffset = 0,
  ): UiMessage[] => {
    let result = projectPiMessages(raw, indexOffset);
    // Pi のメッセージ本体には id が無いため、projectPiMessages は `msg-N` を仮 id
    // にする。「入力欄に戻す」はエントリ id 必須なので、参照一致するエントリの id で上書き
    const entryIds = entryIdsForProjectedMessages(raw, entryIdByMessage);
    result = result.map((message, index) => {
      const entryId = entryIds[index];
      return entryId ? { ...message, id: entryId } : message;
    });
    return result;
  };

  const projectLatestWithEntryIds = (raw: unknown[]): UiMessage[] => {
    const latestIndex = raw.findLastIndex(piRawMessageProjectsToUi);
    return latestIndex < 0
      ? []
      : projectWithEntryIds(raw.slice(latestIndex), latestIndex);
  };

  let projected: UiMessage[];
  if (!streaming || canAppendStreaming) {
    if (useBranchHistory) {
      if (branchCacheHit) {
        projected = cachedBranch!.projected;
      } else {
        projected = projectWithEntryIds(historyRaw);
        branchProjectionCache.set(session, {
          leafId: branchLeafId,
          raw: historyRaw,
          entryIdByMessage,
          projected,
        });
      }
    } else {
      const cached = snapshotProjectionCache.get(session);
      const last = stored[stored.length - 1];
      if (
        cached?.source === stored &&
        cached.length === stored.length &&
        cached.last === last
      ) {
        projected = cached.projected;
      } else {
        projected = projectWithEntryIds(historyRaw);
        snapshotProjectionCache.set(session, {
          source: stored,
          length: stored.length,
          last,
          projected,
        });
      }
    }
    if (canAppendStreaming) {
      const streamingProjection = projectPiMessages([streaming], historyRaw.length);
      if (latestOnly) {
        if (streamingProjection.length > 0) projected = streamingProjection;
      } else {
        projected = projected.concat(streamingProjection);
      }
    }
  } else if (latestOnly && streamingInHistory) {
    // The streaming object can be present in session.messages while it is
    // mutated. Project only the final independent message and its trailing
    // tool results; reprojecting the whole branch defeats delta throttling.
    projected = projectLatestWithEntryIds(historyRaw);
    if (useBranchHistory) branchProjectionCache.delete(session);
    else snapshotProjectionCache.delete(session);
  } else {
    const raw = streamingInHistory ? historyRaw : [...historyRaw, streaming];
    projected = projectWithEntryIds(raw);
    if (streamingInHistory) {
      if (useBranchHistory) {
        branchProjectionCache.set(session, {
          leafId: branchLeafId,
          raw: historyRaw,
          entryIdByMessage,
          projected,
        });
      } else {
        snapshotProjectionCache.set(session, {
          source: stored,
          length: stored.length,
          last: stored[stored.length - 1],
          projected,
        });
      }
    }
  }
  if (latestOnly && projected.length > 1) {
    projected = [projected[projected.length - 1]!];
  }
  if (throughputByStartedAt)
    projected = applyThroughput(projected, throughputByStartedAt);
  if (toolPartialOutputByCallId && toolPartialOutputByCallId.size > 0) {
    projected = applyToolOutput(projected, toolPartialOutputByCallId);
  }
  if (toolStartedAt && toolStartedAt.size > 0 && toolEndedAt) {
    projected = applyToolTiming(projected, toolStartedAt, toolEndedAt);
  }
  if (accountContext) {
    projected = applyMessageAccountIds(projected, accountContext);
  }
  return projected;
}

/** 実行中 tool の累積 partial result を対応する UI パートへ注入する。 */
export function applyToolOutput(
  messages: UiMessage[],
  partialOutputByCallId: Map<string, string>,
): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      const output = partialOutputByCallId.get(part.callID);
      if (
        output === undefined ||
        (part.state.status !== "running" && part.state.status !== "pending")
      ) {
        return part;
      }
      changed = true;
      return {
        ...part,
        state: {
          ...part.state,
          output,
          error: undefined,
        },
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

/** toolCallId に対応する tool パートに実行開始/終了時刻を注入する。 */
export function applyToolTiming(
  messages: UiMessage[],
  toolStartedAt: Map<string, number>,
  toolEndedAt: Map<string, number>,
): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      const startedAtMs = toolStartedAt.get(part.callID);
      if (!startedAtMs) return part;
      changed = true;
      return {
        ...part,
        state: {
          ...part.state,
          startedAtMs,
          endedAtMs: toolEndedAt.get(part.callID) ?? part.state.endedAtMs,
        },
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

function loadThroughputFromSession(session: AgentSession): {
  timings: Map<number, ThroughputTiming>;
  persistedKeys: Set<number>;
} {
  const timings = new Map<number, ThroughputTiming>();
  const persistedKeys = new Set<number>();
  try {
    const entries = session.sessionManager.getEntries();
    for (const entry of entries) {
      if (!isThroughputCustomEntry(entry)) continue;
      const timing = timingFromPersisted((entry as { data?: unknown }).data);
      if (!timing) continue;
      timings.set(timing.startedAtMs, timing);
      persistedKeys.add(timing.startedAtMs);
    }
  } catch {
    /* session may not expose entries yet */
  }
  return { timings, persistedKeys };
}

function persistThroughputSample(
  live: LiveRuntime,
  timing: ThroughputTiming,
): void {
  if (live.persistedThroughputKeys.has(timing.startedAtMs)) return;
  const payload = toPersistedThroughput(timing);
  if (!payload) return;
  // Defer until after Pi appends the assistant message on message_end.
  queueMicrotask(() => {
    if (live.persistedThroughputKeys.has(timing.startedAtMs)) return;
    try {
      live.session.sessionManager.appendCustomEntry(
        THROUGHPUT_CUSTOM_TYPE,
        payload,
      );
      live.persistedThroughputKeys.add(timing.startedAtMs);
      live.throughputByStartedAt.set(timing.startedAtMs, {
        ...timing,
        outputTokens: payload.outputTokens,
        charCount: 0,
      });
    } catch {
      /* persistence is best-effort; in-memory sample still works for this process */
    }
  });
}

function assistantUsageOutput(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const usage = (message as { usage?: { output?: unknown } }).usage;
  if (
    !usage ||
    typeof usage.output !== "number" ||
    !Number.isFinite(usage.output)
  )
    return null;
  return Math.max(0, Math.round(usage.output));
}

function trackThroughputEvent(
  live: LiveRuntime,
  event: { type: string; [key: string]: unknown },
): void {
  if (event.type === "tool_execution_start") {
    const toolCallId =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : typeof event.toolCallID === "string"
          ? event.toolCallID
          : "";
    if (toolCallId) live.toolStartedAt.set(toolCallId, Date.now());
    return;
  }

  if (event.type === "tool_execution_update") {
    const toolCallId =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : typeof event.toolCallID === "string"
          ? event.toolCallID
          : "";
    if (toolCallId) {
      live.toolPartialOutputByCallId.set(
        toolCallId,
        toolResultText(event.partialResult),
      );
    }
    return;
  }

  if (event.type === "tool_execution_end") {
    const toolCallId =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : typeof event.toolCallID === "string"
          ? event.toolCallID
          : "";
    if (toolCallId) {
      live.toolEndedAt.set(toolCallId, Date.now());
      const output = toolResultText(event.result);
      if (output) live.toolPartialOutputByCallId.set(toolCallId, output);
    }
    return;
  }

  if (event.type === "message_end") {
    const message = event.message;
    if (
      message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "toolResult" &&
      typeof (message as { toolCallId?: unknown }).toolCallId === "string"
    ) {
      live.toolPartialOutputByCallId.delete(
        (message as { toolCallId: string }).toolCallId,
      );
    }
    return;
  }

  if (event.type === "message_start") {
    const message = event.message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "assistant") return;
    const startedAt =
      typeof (message as { timestamp?: unknown }).timestamp === "number"
        ? (message as { timestamp: number }).timestamp
        : Date.now();
    if (!live.throughputByStartedAt.has(startedAt)) {
      live.throughputByStartedAt.set(
        startedAt,
        createThroughputTiming(startedAt),
      );
    }
    return;
  }

  if (event.type === "message_update") {
    const message = event.message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "assistant") return;
    const startedAt =
      typeof (message as { timestamp?: unknown }).timestamp === "number"
        ? (message as { timestamp: number }).timestamp
        : null;
    if (startedAt === null) return;
    let timing = live.throughputByStartedAt.get(startedAt);
    if (!timing) {
      timing = createThroughputTiming(startedAt);
      live.throughputByStartedAt.set(startedAt, timing);
    }
    const assistantEvent = event.assistantMessageEvent;
    if (
      assistantEvent &&
      typeof assistantEvent === "object" &&
      isContentDeltaType((assistantEvent as { type?: unknown }).type)
    ) {
      const delta = (assistantEvent as { delta?: unknown }).delta;
      timing = noteContentDelta(
        timing,
        typeof delta === "string" ? delta : undefined,
      );
    }
    timing = noteReportedOutputTokens(timing, assistantUsageOutput(message));
    live.throughputByStartedAt.set(startedAt, timing);
    return;
  }

  if (event.type === "message_end") {
    const message = event.message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "assistant") return;
    const startedAt =
      typeof (message as { timestamp?: unknown }).timestamp === "number"
        ? (message as { timestamp: number }).timestamp
        : null;
    if (startedAt === null) return;
    let timing =
      live.throughputByStartedAt.get(startedAt) ??
      createThroughputTiming(startedAt);
    timing = noteReportedOutputTokens(timing, assistantUsageOutput(message));
    if (timing.lastTokenAtMs === null) {
      timing = { ...timing, lastTokenAtMs: Date.now() };
    }
    live.throughputByStartedAt.set(startedAt, timing);
    persistThroughputSample(live, timing);
  }
}

export function sessionContextUsage(
  session: AgentSession,
): ContextUsageDto | undefined {
  const stored: unknown[] = Array.isArray(session.messages)
    ? session.messages
    : [];
  const last = stored[stored.length - 1];
  const cached = contextUsageCache.get(session);
  if (
    cached?.source === stored &&
    cached.length === stored.length &&
    cached.last === last
  ) {
    return cached.value;
  }
  let value: ContextUsageDto | undefined;
  try {
    value = toContextUsageDto(session.getContextUsage());
  } catch {
    value = undefined;
  }
  contextUsageCache.set(session, {
    source: stored,
    length: stored.length,
    last,
    value,
  });
  return value;
}

function sessionSnapshotFields(
  session: AgentSession,
  throughputByStartedAt?: Map<number, ThroughputTiming>,
  toolStartedAt?: Map<string, number>,
  toolEndedAt?: Map<string, number>,
  toolPartialOutputByCallId?: Map<string, string>,
  accountContext?: MessageAccountContext,
): {
  messages: UiMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  contextUsage: ContextUsageDto | undefined;
  goalLoop: GoalLoopDto | null;
  todos: TodoDto[];
} {
  return {
    messages: snapshotMessages(
      session,
      throughputByStartedAt,
      toolStartedAt,
      toolEndedAt,
      toolPartialOutputByCallId,
      false,
      accountContext,
    ),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    contextUsage: sessionContextUsage(session),
    goalLoop: readGoalLoopState(
      session.sessionManager.getCwd(),
      session.sessionId,
    ),
    todos: todosFromPiMessages(session.messages),
  };
}

function emit(
  taskId: string,
  payload: { type: string; [key: string]: unknown },
): void {
  state().events.emit(taskId, payload);
}

/** プロバイダが「思考オフ不可」の 400 を返したか。 */
export function isReasoningMandatoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reasoning is mandatory/i.test(message);
}

/** 思考必須モデル向けのフォールバックレベル（対応する最下位、なければ minimal）。 */
export function reasoningFallbackLevel(
  model: Model | null | undefined,
): ThinkingLevel {
  const levels = model
    ? thinkingLevelsForModel(model).filter((l) => l !== "off")
    : [];
  return levels[0] ?? "minimal";
}

function emitTaskSnapshot(
  live: LiveRuntime,
  eventType: string,
  extra?: Record<string, unknown>,
): void {
  // SSE リスナーが誰もいないタスクのスナップショット生成（メッセージ射影・
  // エントリ走査・goal loop 読込・todo 抽出）は丸ごと不要。リスナーが付いた
  // タイミングで getTaskDetail が初期状態を送るため欠落は生じない。
  if (state().events.listenerCount(live.taskId) === 0) return;
  const task = getTask(live.taskId);
  if (!task) return;
  emit(live.taskId, {
    type: "snapshot",
    task: toSummary(task),
    ...sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    ),
    manualAbortedAssistantId: live.manualAbortedAssistantId,
    hangRetryCount: live.hangRetryCount,
    eventType,
    ...extra,
  });
}

/**
 * Stream only the newest projected message for token/tool updates.
 * Reuse the cached branch and project the streaming suffix alone through the
 * latestOnly snapshot path.
 */
function emitTaskDelta(live: LiveRuntime, eventType: string): void {
  if (state().events.listenerCount(live.taskId) === 0) return;
  // High-frequency events only change the message and session flags. Task
  // metadata is refreshed by the non-throttled lifecycle snapshots, so avoid
  // the store read and session-file scans performed by toSummary() here.
  const message = snapshotMessages(
    live.session,
    live.throughputByStartedAt,
    live.toolStartedAt,
    live.toolEndedAt,
    live.toolPartialOutputByCallId,
    true,
    { accountId: live.accountId, byMessageId: live.accountByMessageId },
  ).at(-1) ?? null;
  const contextUsage = sessionContextUsage(live.session);
  emit(live.taskId, {
    type: "delta",
    message,
    isStreaming: live.session.isStreaming,
    isCompacting: live.session.isCompacting,
    ...(contextUsage ? { contextUsage } : {}),
    eventType,
  });
}

function scheduleTaskSnapshot(
  live: LiveRuntime,
  eventType: string,
  extra?: Record<string, unknown>,
): void {
  if (NON_RENDERING_SESSION_EVENTS.has(eventType)) return;
  if (!THROTTLED_SNAPSHOT_EVENTS.has(eventType)) {
    if (live.snapshotTimer) {
      clearTimeout(live.snapshotTimer);
      live.snapshotTimer = null;
      live.pendingSnapshotEventType = null;
    }
    emitTaskSnapshot(live, eventType, extra);
    return;
  }
  live.pendingSnapshotEventType = eventType;
  if (live.snapshotTimer) return;
  live.snapshotTimer = setTimeout(() => {
    live.snapshotTimer = null;
    const pendingType = live.pendingSnapshotEventType ?? eventType;
    live.pendingSnapshotEventType = null;
    emitTaskDelta(live, pendingType);
  }, SNAPSHOT_THROTTLE_MS);
}

function mapCompactionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Nothing to compact/i.test(message)) {
    return Object.assign(new Error("圧縮するほど履歴がありません"), {
      status: 400,
    });
  }
  if (/Already compacted/i.test(message)) {
    return Object.assign(new Error("すでに圧縮済みです"), { status: 400 });
  }
  if (
    /Compaction cancelled/i.test(message) ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return Object.assign(new Error("圧縮をキャンセルしました"), {
      status: 400,
    });
  }
  return error instanceof Error ? error : new Error(message);
}

function openSettingsManager() {
  const pi = state().pi;
  if (!pi)
    throw Object.assign(new Error("Pi ランタイムが初期化されていません"), {
      status: 503,
    });
  return pi.SettingsManager.create(homedir(), pi.getAgentDir());
}

async function attachSession(
  taskId: string,
  session: AgentSession,
  skillPermissionRef: { current: SkillPermission },
): Promise<LiveRuntime> {
  const current = state();
  const existing = current.live.get(taskId);
  // タスクの利用アカウント。セッション生存中はマネージャ参照で蒸発対象外にする。
  const attachedAccountId = getTask(taskId)?.accountId ?? null;
  const keepsExistingAccountRef =
    Boolean(attachedAccountId && existing?.accountId === attachedAccountId);
  if (attachedAccountId && !keepsExistingAccountRef) {
    await accountRuntimeManager().acquire(attachedAccountId);
  }
  existing?.unsubscribe();
  if (
    existing &&
    existing.accountId &&
    existing.accountId !== attachedAccountId
  ) {
    accountRuntimeManager().release(existing.accountId);
  }
  const replacedSession = existing?.session;
  if (replacedSession && replacedSession !== session) {
    replacedSession.dispose();
  }

  const loaded = existing ? null : loadThroughputFromSession(session);

  if (existing?.snapshotTimer) {
    clearTimeout(existing.snapshotTimer);
  }

  const live: LiveRuntime = {
    taskId,
    accountId: attachedAccountId,
    accountByMessageId: existing?.accountByMessageId ?? new Map(),
    session,
    skillPermission: skillPermissionRef.current,
    skillPermissionRef,
    unsubscribe: () => undefined,
    // Keep a queued prompt chain when an idle session is replaced for the
    // next turn. The current run owns this promise, so follow-ups submitted
    // during session creation still wait for it.
    promptChain: existing?.promptChain ?? Promise.resolve(),
    promptActive: existing?.promptActive ?? false,
    throughputByStartedAt:
      existing?.throughputByStartedAt ?? loaded?.timings ?? new Map(),
    persistedThroughputKeys:
      existing?.persistedThroughputKeys ?? loaded?.persistedKeys ?? new Set(),
    toolStartedAt: existing?.toolStartedAt ?? new Map(),
    toolEndedAt: existing?.toolEndedAt ?? new Map(),
    toolPartialOutputByCallId: existing?.toolPartialOutputByCallId ?? new Map(),
    snapshotTimer: null,
    pendingSnapshotEventType: null,
    revertLeafId: null,
    manualAbortedAssistantId: null,
    hangRetryCount: 0,
    reasoningFallbackTried: false,
  };

  const unsubscribe = session.subscribe((event) => {
    const syncTask =
      event.type === "agent_start" ||
      event.type === "agent_settled" ||
      (event.type === "agent_end" && !event.willRetry) ||
      (event.type === "compaction_end" &&
        !event.aborted &&
        Boolean(event.errorMessage) &&
        event.reason !== "manual");
    // Message/tool deltas arrive much more often than task metadata changes.
    // Avoid a synchronous store read for every token; status/identity changes
    // still use the existing path below.
    const task = syncTask ? getTask(taskId) : undefined;
    if (syncTask && !task) return;
    trackThroughputEvent(
      live,
      event as { type: string; [key: string]: unknown },
    );
    if (event.type === "agent_start") {
      setTaskStatus(taskId, "working");
    }
    if (
      event.type === "agent_settled" ||
      (event.type === "agent_end" && !event.willRetry)
    ) {
      const error = session.agent.state.errorMessage ?? null;
      setTaskStatus(taskId, error ? "error" : "idle", error);
    }
    if (
      event.type === "compaction_end" &&
      !event.aborted &&
      event.errorMessage &&
      event.reason !== "manual"
    ) {
      setTaskStatus(taskId, "error", event.errorMessage);
    }
    if (task) {
      const ids = modelId(session.model);
      const identityPatch = sessionIdentityPatch(task, {
        providerID: ids.providerID,
        modelID: ids.modelID,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
      });
      if (Object.keys(identityPatch).length > 0) {
        patchTask(taskId, identityPatch);
      }
    }
    scheduleTaskSnapshot(
      live,
      event.type,
      event.type === "compaction_end" && event.errorMessage
        ? { error: event.errorMessage }
        : undefined,
    );
  });

  live.unsubscribe = () => {
    if (live.snapshotTimer) {
      clearTimeout(live.snapshotTimer);
      live.snapshotTimer = null;
      const pendingType = live.pendingSnapshotEventType;
      live.pendingSnapshotEventType = null;
      if (pendingType) {
        emitTaskDelta(live, pendingType);
      }
    }
    unsubscribe();
  };
  current.live.set(taskId, live);
  return live;
}

/** live セッションを破棄し、保持していたアカウントランタイムの参照を解放する。 */
function disposeLive(taskId: string): void {
  const live = state().live.get(taskId);
  if (!live) return;
  live.unsubscribe();
  live.session.dispose();
  state().live.delete(taskId);
  if (live.accountId) {
    const manager = accountRuntimeManager();
    manager.release(live.accountId);
    manager.evictIdle();
  }
}

export function syncSessionName(
  sessionManager: {
    getSessionName(): string | undefined;
    appendSessionInfo(name: string): unknown;
  },
  sessionName: string | undefined,
): void {
  if (sessionName && sessionManager.getSessionName() !== sessionName)
    sessionManager.appendSessionInfo(sessionName);
}

async function createSession(options: {
  cwd: string;
  sessionFile?: string | null;
  sessionName?: string;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  skillPermission?: SkillPermission;
  /** 利用する認証アカウント（null = 既定）。 */
  accountId?: string | null;
  /** pi-subagents agent running as the main session persona. */
  agentName?: string | null;
}): Promise<SessionSetup> {
  const pi = await loadPi();
  await ensureRuntime();
  const agentDir = pi.getAgentDir();
  const sessionManager = options.sessionFile
    ? pi.SessionManager.open(options.sessionFile)
    : pi.SessionManager.create(options.cwd);
  syncSessionName(sessionManager, options.sessionName);
  const skillPermissionRef = {
    current: options.skillPermission ?? ("allow" as SkillPermission),
  };
  // Filter disabled skills via state file (skills-state.json), not folder moves.
  // skillsOverride re-reads state on every resourceLoader.reload() / session.reload().
  // Also drop any ~/.agents skills Pi loads internally: this harness must not
  // read C:\Users\Daichi\.agents (skills.ts discovery already excludes it).
  // Bundled WebUI extensions (goal-loop / todowrite / permission-gate) load
  // straight from this repository's extensions/ dir; stale same-name copies
  // under ~/.pi are dropped so they never register duplicate tools.
  const collaborationMode = readCollaborationConfig().config.mode;
  const collaborationEnabled = collaborationMode !== "off";
  const bundled = bundledExtensionEntries();
  const bundledNames = new Set(bundled.map((entry) => entry.name));
  const activeBundled = bundled.filter(
    (entry) =>
      collaborationEnabled ||
      entry.name !== LEAFCODE_COLLABORATION_EXTENSION_NAME,
  );
  const bundledPaths = new Set(activeBundled.map((entry) => entry.filePath));
  const collaborationEntry = activeBundled.find(
    (entry) => entry.name === LEAFCODE_COLLABORATION_EXTENSION_NAME,
  );
  if (collaborationEnabled && !collaborationEntry) {
    throw new Error(
      `Required bundled extension '${LEAFCODE_COLLABORATION_EXTENSION_NAME}' is missing; refusing to start a mutable session.`,
    );
  }
  // The bundled leafcode-subagents fork replaces the npm pi-subagents package:
  // drop the npm extension so the `subagent` tool is never registered twice.
  const forkOwnsSubagents = bundledNames.has("leafcode-subagents");
  // Selected agent becomes the main persona: its system prompt replaces (or
  // appends to) the base prompt, and context files / skills follow the agent's
  // inherit flags — mirroring how pi-subagents launches child sessions.
  const agentDefinition = options.agentName
    ? loadAgentDefinition(options.agentName, agentDir)
    : undefined;
  const agentOptions = agentDefinition
    ? buildAgentResourceOptions(agentDefinition)
    : undefined;
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    additionalExtensionPaths: activeBundled.map((entry) => entry.filePath),
    skillsOverride: (base) => {
      if (agentOptions?.noSkills || skillPermissionRef.current === "deny") {
        return { skills: [], diagnostics: base.diagnostics };
      }
      return {
        skills: filterSkillsByState(base.skills).filter(
          (skill) => !isAgentsSkill(skill),
        ),
        diagnostics: base.diagnostics,
      };
    },
    extensionsOverride: (base) => ({
      ...base,
      extensions: filterExtensionsByState(
        base.extensions.filter(
          (extension) =>
            !(
              forkOwnsSubagents &&
              basenameKey(extension.path) === "pi-subagents"
            ) &&
            (!bundledNames.has(basenameKey(extension.path)) ||
              bundledPaths.has(resolve(extension.path))),
        ),
      ),
    }),
    ...(agentOptions?.systemPrompt
      ? { systemPrompt: agentOptions.systemPrompt }
      : {}),
    ...(agentOptions?.appendSystemPrompt
      ? { appendSystemPrompt: agentOptions.appendSystemPrompt }
      : {}),
    ...(agentOptions?.noContextFiles ? { noContextFiles: true } : {}),
  });
  await resourceLoader.reload();
  const loadedExtensions = resourceLoader.getExtensions();
  const collaborationExtension =
    collaborationEntry &&
    loadedExtensions.extensions.find(
      (extension) =>
        basenameKey(extension.resolvedPath) ===
          LEAFCODE_COLLABORATION_EXTENSION_NAME &&
        resolve(extension.resolvedPath) ===
          resolve(collaborationEntry.filePath),
    );
  const missingCollaborationTools = LEAFCODE_COLLABORATION_TOOL_NAMES.filter(
    (name) => !collaborationExtension?.tools.has(name),
  );
  if (
    collaborationEnabled &&
    (!collaborationExtension || missingCollaborationTools.length > 0)
  ) {
    const loadError = loadedExtensions.errors
      .filter(
        (entry) =>
          basenameKey(entry.path) === LEAFCODE_COLLABORATION_EXTENSION_NAME,
      )
      .map((entry) => entry.error)
      .join("; ");
    throw new Error(
      `Required collaboration extension failed to load; refusing to start a mutable session.${
        missingCollaborationTools.length > 0
          ? ` Missing tools: ${missingCollaborationTools.join(", ")}.`
          : ""
      }${loadError ? ` ${loadError}` : ""}`,
    );
  }
  const permissionMode =
    options.permissionMode ?? readPermissionGateConfig(options.cwd);
  const persistPermission = options.permissionMode !== undefined;
  applyPermissionMode(
    { extensionRunner: undefined },
    options.cwd,
    permissionMode,
    {
      persist: persistPermission,
    },
  );
  // Agent-defined tool allowlist wins; otherwise default tools. The `subagent`
  // tool is only exposed when subagent permission is "allow" (delegation stays
  // independent from running an agent as the main persona).
  const configuredTools =
    agentOptions?.tools ??
    (options.subagentPermission === "allow"
      ? [
          "read",
          "write",
          "edit",
          "powershell",
          "question",
          "grep",
          "find",
          "ls",
          "subagent",
          "todowrite",
        ]
      : [
          "read",
          "write",
          "edit",
          "powershell",
          "question",
          "grep",
          "find",
          "ls",
          "todowrite",
        ]);
  const tools = applyCollaborationToolPolicy(
    configuredTools,
    collaborationMode,
  );
  const result = await pi.createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager,
    resourceLoader,
    modelRuntime: (await getRuntimeFor(options.accountId)) ?? undefined,
    tools,
  });
  applyPermissionMode(result.session, options.cwd, permissionMode, {
    persist: persistPermission,
  });
  // bindExtensions() emits session_start; bundled extensions (goal-loop 等)
  // create their per-session runtime there. Without it /goal-start silently
  // no-ops because the extension never sees a runtime.
  await result.session.bindExtensions({
    onError: (error) => {
      console.error(
        `[extension] ${error.extensionPath} (${error.event}):`,
        error.error,
      );
    },
  });
  // Agent-defined tools may include `subagent`; enforce the user choice after
  // the full extension registry is ready, including the initial turn.
  applySubagentPermission(result.session, options.subagentPermission);
  return { session: result.session, skillPermissionRef };
}

type ConcreteModelRoute = {
  accountId: string | null;
  runtime: ModelRuntime;
  model: Model;
};

function routeLimitError(resetAt: string | null): Error {
  return Object.assign(
    new Error(
      resetAt
        ? `利用可能なアカウントがありません。次回リセット: ${resetAt}`
        : "利用可能なアカウントがありません",
    ),
    { status: 429, ...(resetAt ? { resetAt } : {}) },
  );
}

async function resolveIntegratedModelRoute(
  providerID: string,
  modelID: string,
): Promise<ConcreteModelRoute | undefined> {
  const accounts = listAccounts().filter((account) =>
    accountHasProvider(account, providerID),
  );
  const records = (await collectAccountModelRecords(accounts)).filter(
    (record) =>
      record.option.providerID === providerID &&
      record.option.modelID === modelID,
  );
  if (records.length === 0) return undefined;

  const usageProviders = getCachedUsage()?.providers ?? [];
  const workingCounts = workingTaskCounts([providerID]);
  const candidates: RoutingCandidate<AccountModelRecord>[] = records.map(
    (record) => ({
      accountId: record.accountId,
      accountIndex: record.accountIndex,
      value: record,
      usage:
        usageProviders.find(
          (provider) =>
            provider.id === providerID &&
            provider.accountId === record.accountId,
        ) ?? null,
      workingTaskCount:
        workingCounts.get(`${providerID}::${record.accountId}`) ?? 0,
    }),
  );
  const decision = chooseRoutingCandidate(candidates);
  if (!decision.candidate) {
    if (decision.allMaxed) throw routeLimitError(decision.resetAt);
    return undefined;
  }

  for (const candidate of decision.ranked) {
    if (candidate.tier >= 3) continue;
    const model = candidate.value.runtime.getModel(providerID, modelID);
    if (model) {
      return {
        accountId: candidate.accountId,
        runtime: candidate.value.runtime,
        model,
      };
    }
  }
  return undefined;
}

async function resolveConcreteModel(
  value: string | undefined,
  requestedAccountId?: string | null,
  options?: { strictAccountId?: boolean },
): Promise<ConcreteModelRoute | undefined> {
  await ensureRuntime();
  const parsed = parseModelValue(value);
  if (!parsed) return undefined;

  const explicitAccountId = parsed.accountId;
  const requested = requestedAccountId?.trim() || explicitAccountId;
  const strictAccountId =
    options?.strictAccountId === true || Boolean(explicitAccountId);
  if (requested && isAccountRoutingProvider(parsed.providerID)) {
    const account = getAccount(requested);
    if (!account) {
      if (strictAccountId)
        throw Object.assign(new Error("アカウントが見つかりません"), {
          status: 404,
        });
    } else if (!accountHasProvider(account, parsed.providerID)) {
      if (strictAccountId) {
        throw Object.assign(
          new Error("アカウントに紐づかないプロバイダーです"),
          { status: 400 },
        );
      }
    } else {
      const record = (await collectAccountModelRecords([account])).find(
        (entry) =>
          entry.option.providerID === parsed.providerID &&
          entry.option.modelID === parsed.modelID,
      );
      if (!record) return undefined;
      const model = record.runtime.getModel(parsed.providerID, parsed.modelID);
      return model
        ? { accountId: requested, runtime: record.runtime, model }
        : undefined;
    }
  }

  if (
    !explicitAccountId &&
    isAccountRoutingProvider(parsed.providerID) &&
    runsThroughAccounts(parsed.providerID) &&
    accountRoutingMode(parsed.providerID) === "integrated"
  ) {
    return resolveIntegratedModelRoute(parsed.providerID, parsed.modelID);
  }

  // Shared providers never use an account runtime, even when a caller carries
  // a task account for a different provider.
  const runtime = await getRuntimeFor();
  if (!runtime) return undefined;
  const model = runtime.getModel(parsed.providerID, parsed.modelID);
  return model ? { accountId: null, runtime, model } : undefined;
}

function toGoalLoopSummary(
  loop: GoalLoopDto | null,
): GoalLoopSummaryDto | undefined {
  if (!loop) return undefined;
  return {
    status: loop.status,
    maxTurns: loop.maxTurns,
    turnCount: loop.turnCount,
  };
}

function toSummary(task: TaskSummary): TaskSummary {
  const live = state().live.get(task.id);
  if (!live) return task;
  const ids = modelId(live.session.model);
  const todoProgress = todoProgressFromTodos(
    todosFromPiMessages(live.session.messages),
  );
  const goalLoopSummary = toGoalLoopSummary(
    readGoalLoopState(
      live.session.sessionManager.getCwd(),
      live.session.sessionId,
    ),
  );
  const thinking =
    typeof live.session.thinkingLevel === "string" &&
    isThinkingLevel(live.session.thinkingLevel)
      ? live.session.thinkingLevel
      : task.thinkingLevel;
  return {
    ...task,
    status: live.session.isStreaming ? "working" : task.status,
    sessionId: live.session.sessionId ?? task.sessionId,
    sessionFile: live.session.sessionFile ?? task.sessionFile,
    providerID: ids.providerID ?? task.providerID,
    modelID: ids.modelID ?? task.modelID,
    thinkingLevel: thinking,
    ...(todoProgress ? { todoProgress } : {}),
    ...(goalLoopSummary ? { goalLoopSummary } : {}),
  };
}

async function ensureLive(taskId: string): Promise<LiveRuntime> {
  const current = state();
  const existing = current.live.get(taskId);
  if (existing) return existing;

  const inflight = ensureLiveInflight.get(taskId);
  if (inflight) return inflight;

  const promise = (async () => {
    const again = state().live.get(taskId);
    if (again) return again;

    const task = getTask(taskId);
    if (!task)
      throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
    const project = getProject(task.projectId);
    const cwd = project?.rootPath ?? task.directory;
    const modelRoute = await resolveConcreteModel(
      task.providerID && task.modelID
        ? modelValue(task.providerID, task.modelID)
        : undefined,
      task.accountId ?? null,
      { strictAccountId: true },
    );
    const model = modelRoute?.model;
    if (task.providerID && task.modelID && !modelRoute) {
      throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
    }
    const sessionAccountId =
      modelRoute?.accountId ??
      (!task.providerID ? (task.accountId ?? null) : null);
    const setup = await createSession({
      cwd,
      sessionFile: task.sessionFile,
      sessionName: task.title,
      accountId: sessionAccountId,
      model,
      thinkingLevel: task.thinkingLevel,
      skillPermission: task.skillPermission,
      agentName: task.agent ?? null,
    });
    patchTask(taskId, {
      sessionId: setup.session.sessionId,
      sessionFile: setup.session.sessionFile,
      ...modelId(setup.session.model),
    });
    return await attachSession(taskId, setup.session, setup.skillPermissionRef);
  })().finally(() => {
    if (ensureLiveInflight.get(taskId) === promise) {
      ensureLiveInflight.delete(taskId);
    }
  });

  ensureLiveInflight.set(taskId, promise);
  return promise;
}

function validateProjectPath(
  rootPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!isAbsolutePath(rootPath)) {
    return { ok: false, error: "絶対パスを指定してください" };
  }
  const canonical = resolve(rootPath);
  if (!existsSync(canonical)) {
    return { ok: false, error: "フォルダが見つかりません" };
  }
  try {
    if (!statSync(canonical).isDirectory()) {
      return { ok: false, error: "ディレクトリではありません" };
    }
  } catch {
    return { ok: false, error: "フォルダにアクセスできません" };
  }
  return { ok: true, path: canonical };
}

async function syncProvidersBestEffort(
  runtime: ModelRuntime,
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await syncLlamaServerProvider(runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`llama-server: ${message}`);
    console.warn("[leafcode-pi] llama-server provider sync failed:", message);
  }
  try {
    await syncOllamaCloudProvider(runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`ollama-cloud: ${message}`);
    console.warn("[leafcode-pi] ollama-cloud provider sync failed:", message);
  }
  state().lastProviderSyncWarnings = warnings;
  return warnings;
}

/**
 * `/api/health` is the most frequently polled endpoint (sidebar: 4s while a task
 * runs, 12s idle) and the only expensive part is `listModels()`, which re-syncs
 * llama-server / Ollama Cloud and rebuilds the provider catalog every call
 * (~250ms measured). A short TTL keeps the poll nearly free.
 */
const HEALTH_TTL_MS = 15_000;
const MODEL_TTL_MS = 15_000;

type HealthCacheEntry = { at: number; value: HealthDto };
type ModelCacheEntry = { at: number; value: ModelOption[] };
type AccountModelCacheEntry = ModelCacheEntry & { key: string };
type AccountModelInflight = { key: string; promise: Promise<ModelOption[]> };

/** Fresh cache entries only; unhealthy snapshots are never cached (see below). */
export function readHealthCache(
  entry: HealthCacheEntry | null,
  now: number,
  ttlMs = HEALTH_TTL_MS,
): HealthDto | null {
  if (!entry) return null;
  const age = now - entry.at;
  if (age < 0 || age >= ttlMs) return null;
  return entry.value;
}

/**
 * Never cache a broken engine: HomeView polls every 3s waiting for `engineOk`
 * to flip true, so caching the failure would delay recovery by up to the TTL.
 */
export function nextHealthCache(
  value: HealthDto,
  now: number,
): HealthCacheEntry | null {
  return value.engineOk ? { at: now, value } : null;
}

export function readModelCache(
  entry: ModelCacheEntry | null,
  now: number,
  ttlMs = MODEL_TTL_MS,
): ModelOption[] | null {
  if (!entry) return null;
  const age = now - entry.at;
  if (age < 0 || age >= ttlMs) return null;
  return entry.value;
}

export function nextModelCache(
  value: ModelOption[],
  now: number,
): ModelCacheEntry | null {
  // Do not hide recovery from the model picker while the engine has no models.
  return value.length > 0 ? { at: now, value } : null;
}

/** Drop the cached snapshot after anything that can change the model list. */
export function invalidateHealthCache(): void {
  const current = state();
  current.healthCache = null;
  current.modelCache = null;
  current.accountModelCache = null;
}

function accountModelsKey(
  accounts: readonly Pick<AccountRecord, "id" | "label" | "providers">[],
): string {
  return JSON.stringify(
    accounts.map((account) => [account.id, account.label, account.providers]),
  );
}

async function hasStoredAccountProvider(
  accounts: readonly Pick<AccountRecord, "id" | "providers">[],
): Promise<boolean> {
  if (accounts.length === 0) return false;
  try {
    const agentDir = await resolvePiAgentDir();
    return accounts.some(
      (account) => storedAccountProviderIds(account, agentDir).length > 0,
    );
  } catch {
    return false;
  }
}

/** Credentials that belong to this account, excluding ambient environment auth. */
function storedAccountProviderIds(
  account: Pick<AccountRecord, "id" | "providers">,
  agentDir: string,
): AccountProviderId[] {
  const stored = new Set(accountStoredProviders(account.id, agentDir));
  return account.providers.filter((provider) => stored.has(provider));
}

/**
 * このプロバイダーが今アカウント経由で動くか。true なら既定（非アカウント）認証の
 * モデルを隠し、統合ルーティングの対象にする。マルチアカウント対応プロバイダーは
 * 常に true とし、既定モデルを新規候補へ出さない。
 */
function runsThroughAccounts(providerId: string): boolean {
  return isAccountOnlyProvider(providerId);
}

export async function getHealth(): Promise<HealthDto> {
  const cached = readHealthCache(state().healthCache, Date.now());
  if (cached) return cached;

  try {
    await ensureRuntime();
  } catch {
    /* initError is set */
  }
  const current = state();
  const accounts = listAccounts();
  const sharedModels = (await getRuntimeFor())
    ? (await listModels().catch(() => [])).filter(
        (model) => !runsThroughAccounts(model.providerID),
      )
    : [];
  const accountSnapshot =
    current.accountModelCache?.key === accountModelsKey(accounts)
      ? current.accountModelCache.value
      : null;
  // ponytail: cold health reads auth files instead of constructing every account runtime;
  // /api/models replaces the count with an exact combined snapshot.
  const accountReady = accountSnapshot
    ? false
    : await hasStoredAccountProvider(accounts);
  const modelCount = accountSnapshot?.length ?? sharedModels.length;
  const value: HealthDto = {
    ok: !current.initError,
    engine: "pi",
    engineOk: !current.initError && (modelCount > 0 || accountReady),
    version: packageVersion(),
    modelCount,
    dataDir: dataDir(),
    error: current.initError,
    ...(current.lastProviderSyncWarnings.length > 0
      ? { warnings: [...current.lastProviderSyncWarnings] }
      : {}),
  };
  current.healthCache = nextHealthCache(value, Date.now());
  return value;
}

/** ランタイムごとの有効モデル一覧を構築する（既定・アカウント共通の処理）。 */
async function buildModelOptions(
  runtime: ModelRuntime,
  accountId?: string,
  providerIds?: readonly string[],
): Promise<ModelOption[]> {
  if (!accountId) await syncProvidersBestEffort(runtime);
  const catalog = accountId
    ? buildProviderModelsCatalog(runtime, readProviderModelState(), accountId)
    : buildProviderModelsCatalog(runtime);
  const enabled = new Set(
    enabledModelOptionsFromCatalog(catalog).map((option) => option.value),
  );
  const available = providerIds
    ? (
        await Promise.all(
          providerIds.map((providerId) => runtime.getAvailable(providerId)),
        )
      ).flat()
    : await runtime.getAvailable();
  const options: ModelOption[] = [];
  for (const model of available) {
    const providerID = String(model.provider);
    const modelID = model.id;
    const value = modelValue(providerID, modelID);
    if (!enabled.has(value)) continue;
    options.push({
      value,
      label: model.name || modelID,
      providerID,
      modelID,
      input: [...model.input],
      reasoning: Boolean(model.reasoning),
      thinkingLevels: thinkingLevelsForModel(model),
    });
  }
  // Preserve settings order from the catalog.
  const order = enabledModelOptionsFromCatalog(catalog).map(
    (option) => option.value,
  );
  const rank = new Map(order.map((value, index) => [value, index]));
  options.sort(
    (a, b) => (rank.get(a.value) ?? 1e9) - (rank.get(b.value) ?? 1e9),
  );
  return options;
}

export async function listModels(): Promise<ModelOption[]> {
  const current = state();
  const cached = readModelCache(current.modelCache, Date.now());
  if (cached) return cached;
  if (current.modelInflight) return current.modelInflight;

  current.modelInflight = (async () => {
    await ensureRuntime();
    const runtime = await getRuntimeFor();
    if (!runtime) return [];
    const options = await buildModelOptions(runtime);
    current.modelCache = nextModelCache(options, Date.now());
    return options;
  })().finally(() => {
    current.modelInflight = null;
  });
  return current.modelInflight;
}

type AccountModelRecord = {
  accountId: string;
  accountLabel: string;
  accountIndex: number;
  modelIndex: number;
  runtime: ModelRuntime;
  option: ModelOption;
};

async function collectAccountModelRecords(
  accounts: Pick<AccountRecord, "id" | "label" | "providers">[],
): Promise<AccountModelRecord[]> {
  if (accounts.length === 0) return [];
  let agentDir: string;
  try {
    agentDir = await resolvePiAgentDir();
  } catch {
    return [];
  }
  const recordsByAccount = await Promise.all(
    accounts.map(async (account, accountIndex) => {
      const records: AccountModelRecord[] = [];
      const providerIds = storedAccountProviderIds(account, agentDir);
      if (providerIds.length === 0) return records;
      try {
        const runtime = await getRuntimeFor(account.id);
        if (!runtime) return records;
        const built = await buildModelOptions(
          runtime,
          account.id,
          providerIds,
        );
        for (const [modelIndex, option] of built.entries()) {
          // API キー等で構成された他プロバイダを、この OAuth アカウントの枠へ複製しない。
          if (!accountHasProvider(account, option.providerID)) continue;
          records.push({
            accountId: account.id,
            accountLabel: account.label,
            accountIndex,
            modelIndex,
            runtime,
            option,
          });
        }
      } catch {
        // そのアカウントのランタイム初期化失敗は無視して残りの一覧を返す
      }
      return records;
    }),
  );
  return recordsByAccount.flat();
}

function intersection<T extends string>(
  values: readonly (readonly T[] | undefined)[],
): T[] | undefined {
  const first = values[0];
  if (!first) return undefined;
  return first.filter((value) =>
    values.every((items) => items?.includes(value)),
  );
}

function accountRowRank(
  providerID: string,
  accountId: string,
  accountIndex: number,
  rowOrder: ReadonlyMap<string, number>,
): number {
  return (
    rowOrder.get(accountProviderModelKey(providerID, accountId)) ??
    rowOrder.get(providerID) ??
    1_000_000 + accountIndex
  );
}

function integratedOption(
  records: readonly AccountModelRecord[],
  usageProviders: readonly CodexBarProvider[],
  workingCounts: ReadonlyMap<string, number>,
): ModelOption {
  const first = records[0]!;
  const providerID = first.option.providerID;
  const modelID = first.option.modelID;
  const candidates: RoutingCandidate<AccountModelRecord>[] = records.map(
    (record) => ({
      accountId: record.accountId,
      accountIndex: record.accountIndex,
      value: record,
      usage:
        usageProviders.find(
          (provider) =>
            provider.id === providerID &&
            provider.accountId === record.accountId,
        ) ?? null,
      workingTaskCount:
        workingCounts.get(`${providerID}::${record.accountId}`) ?? 0,
    }),
  );
  const decision = chooseRoutingCandidate(candidates);
  const selectedUsage = decision.candidate?.usage;
  const input = intersection(records.map((record) => record.option.input));
  const thinkingLevels = intersection(
    records.map((record) => record.option.thinkingLevels),
  );
  return {
    value: `${providerID}::${modelID}`,
    label: first.option.label,
    providerID,
    modelID,
    ...(input ? { input } : {}),
    reasoning: records.every((record) => record.option.reasoning === true),
    ...(thinkingLevels ? { thinkingLevels } : {}),
    codexbarUsedPercent: selectedUsage?.usedPercent ?? null,
    codexbarMaxed: decision.allMaxed,
    routingMode: "integrated",
    routingCandidateCount: records.length,
  };
}

function workingTaskCounts(
  providerIds: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const allowed = new Set(providerIds);
  for (const task of listTasks(false)) {
    if (
      task.status !== "working" ||
      !task.accountId ||
      !task.providerID ||
      !allowed.has(task.providerID)
    )
      continue;
    const key = `${task.providerID}::${task.accountId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [providerID, accounts] of routeReservations) {
    if (!allowed.has(providerID)) continue;
    for (const [accountId, count] of accounts) {
      const key = `${providerID}::${accountId}`;
      counts.set(key, (counts.get(key) ?? 0) + count);
    }
  }
  return counts;
}

/**
 * 既定の非アカウントプロバイダ + 全アカウントのモデルを返す。統合モードの
 * 統合モードのアカウント対応プロバイダーは provider/model ごとに 1 option へまとめる。
 */
async function buildModelsForAccounts(
  accounts: Pick<AccountRecord, "id" | "label" | "providers">[],
): Promise<ModelOption[]> {
  const sharedOptions: ModelOption[] = (
    await listModels().catch(() => [])
  ).filter((option) => !runsThroughAccounts(option.providerID));
  const records = await collectAccountModelRecords(accounts);
  const routingState = readProviderRouting();
  const rowOrder = new Map(
    readProviderModelState().providerOrder.map((key, index) => [key, index]),
  );
  const integrated = new Map<string, AccountModelRecord[]>();
  const separate: ModelOption[] = [];
  for (const record of records) {
    const { providerID, modelID } = record.option;
    if (
      isAccountRoutingProvider(providerID) &&
      accountRoutingMode(providerID, routingState) === "integrated"
    ) {
      const key = `${providerID}::${modelID}`;
      const group = integrated.get(key) ?? [];
      group.push(record);
      integrated.set(key, group);
    } else {
      separate.push({
        ...record.option,
        value: `${record.accountId}::${record.option.value}`,
        accountId: record.accountId,
        accountLabel: record.accountLabel,
      });
    }
  }

  // The picker may display the same 30-minute last-good window as /api/models;
  // execution routing below deliberately uses getCachedUsage's strict 5-minute TTL.
  const usageProviders =
    getCachedUsage(Date.now(), 30 * 60 * 1000)?.providers ?? [];
  const workingCounts = workingTaskCounts([
    ...new Set(records.map((record) => record.option.providerID)),
  ]);
  const integratedOptions = [...integrated.values()]
    .map((group) =>
      [...group].sort(
        (a, b) =>
          accountRowRank(
            a.option.providerID,
            a.accountId,
            a.accountIndex,
            rowOrder,
          ) -
            accountRowRank(
              b.option.providerID,
              b.accountId,
              b.accountIndex,
              rowOrder,
            ) ||
          a.modelIndex - b.modelIndex ||
          a.accountIndex - b.accountIndex,
      ),
    )
    .sort((a, b) => {
      const firstA = a[0]!;
      const firstB = b[0]!;
      return (
        accountRowRank(
          firstA.option.providerID,
          firstA.accountId,
          firstA.accountIndex,
          rowOrder,
        ) -
          accountRowRank(
            firstB.option.providerID,
            firstB.accountId,
            firstB.accountIndex,
            rowOrder,
          ) ||
        firstA.modelIndex - firstB.modelIndex ||
        firstA.option.modelID.localeCompare(firstB.option.modelID, "en")
      );
    })
    .map((group) => integratedOption(group, usageProviders, workingCounts));

  const providerRank = await resolveProviderDisplayRank();
  const accountIndex = new Map(
    accounts.map((account, index) => [account.id, index]),
  );
  const all = [...sharedOptions, ...separate, ...integratedOptions];
  const rowRank = (option: ModelOption): number | undefined => {
    if (
      option.routingMode === "integrated" &&
      isAccountRoutingProvider(option.providerID)
    ) {
      // 統合モードの設定行はプロバイダキーで保存される。providerOrder に旧アカウント別
      // キーが残っていても、表示中の行の順（プロバイダキー）を優先する。
      const own = rowOrder.get(option.providerID);
      if (own !== undefined) return own;
      const ranks = accounts
        .filter((account) => accountHasProvider(account, option.providerID))
        .map((account, index) =>
          accountRowRank(option.providerID, account.id, index, rowOrder),
        );
      return ranks.length > 0 ? Math.min(...ranks) : undefined;
    }
    return rowOrder.get(
      option.accountId
        ? accountProviderModelKey(option.providerID, option.accountId)
        : option.providerID,
    );
  };
  return all.sort((a, b) => {
    const aRank = rowRank(a);
    const bRank = rowRank(b);
    if (aRank !== undefined || bRank !== undefined) {
      const rowDiff =
        (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
      if (rowDiff !== 0) return rowDiff;
    }
    const providerDiff =
      providerRank(a.providerID) - providerRank(b.providerID);
    if (providerDiff !== 0) return providerDiff;
    const aAccount = a.accountId
      ? (accountIndex.get(a.accountId) ?? accounts.length)
      : -1;
    const bAccount = b.accountId
      ? (accountIndex.get(b.accountId) ?? accounts.length)
      : -1;
    return aAccount - bAccount;
  });
}

export async function listModelsForAccounts(
  accounts: Pick<AccountRecord, "id" | "label" | "providers">[],
): Promise<ModelOption[]> {
  const current = state();
  const key = accountModelsKey(accounts);
  const cached = current.accountModelCache;
  if (cached?.key === key) {
    const value = readModelCache(cached, Date.now());
    if (value) return value;
  }
  if (current.accountModelInflight?.key === key) {
    return current.accountModelInflight.promise;
  }

  const promise = buildModelsForAccounts(accounts);
  current.accountModelInflight = { key, promise };
  try {
    const value = await promise;
    current.accountModelCache = { key, at: Date.now(), value };
    current.healthCache = null;
    return value;
  } finally {
    if (current.accountModelInflight?.promise === promise) {
      current.accountModelInflight = null;
    }
  }
}

/** モデル一覧のプロバイダ表示順。providerOrder で未指定のプロバイダは既定カタログ順の末尾。 */
async function resolveProviderDisplayRank(): Promise<
  (providerID: string) => number
> {
  const rank = new Map<string, number>();
  const runtime = await getRuntimeFor();
  if (runtime) {
    const ordered = sortByPreferredOrder(
      runtime.getProviders().map((provider) => provider.id),
      readProviderModelState().providerOrder,
      (id) => id,
    );
    ordered.forEach((id, index) => rank.set(id, index));
  }
  return (providerID: string) =>
    rank.get(providerID) ?? Number.MAX_SAFE_INTEGER;
}

const DIRECT_MAX_TOKENS = 16_384;
const DIRECT_DEFAULT_REASONING_BUDGET = 8_192;
const DIRECT_REASONING_BUDGETS: Record<
  Exclude<ThinkingLevel, "off">,
  number
> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
  max: 16_384,
};

function directCompletionMaxTokens(
  model: Model,
  requested: number | undefined,
  reasoning: Exclude<ThinkingLevel, "off"> | undefined,
): number {
  const answerTokens = Math.min(
    1_024,
    Math.max(1, Math.floor(requested ?? 256)),
  );
  if (!model.reasoning && !reasoning) return answerTokens;
  const modelMaxTokens =
    typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
      ? Math.max(1, Math.floor(model.maxTokens))
      : DIRECT_MAX_TOKENS;
  return Math.min(
    DIRECT_MAX_TOKENS,
    modelMaxTokens,
    answerTokens +
      (reasoning
        ? DIRECT_REASONING_BUDGETS[reasoning]
        : DIRECT_DEFAULT_REASONING_BUDGET),
  );
}

/** Complete a short prompt through Pi's registered provider, without tools or an agent session. */
export async function completeModelText(options: {
  providerID: string;
  modelID: string;
  /** Optional concrete account; ignored for shared providers. */
  accountId?: string | null;
  /** Set only when accountId came from an explicit model setting, not task context. */
  accountIdExplicit?: boolean;
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: Exclude<ThinkingLevel, "off">;
  signal?: AbortSignal;
}): Promise<string> {
  const system = options.system.trim();
  const prompt = options.prompt.trim();
  if (!system || !prompt) throw new Error("生成プロンプトが空です");

  const route = await resolveConcreteModel(
    `${options.providerID}::${options.modelID}`,
    options.accountId ?? null,
    { strictAccountId: options.accountIdExplicit === true },
  );
  if (!route)
    throw new Error(
      `モデルが見つかりません: ${options.providerID}::${options.modelID}`,
    );
  const heldAccountId = route.accountId;
  const manager = heldAccountId ? accountRuntimeManager() : null;
  const runtime = manager
    ? await manager.acquire(heldAccountId!)
    : route.runtime;
  try {
    const model = manager
      ? runtime.getModel(options.providerID, options.modelID)
      : route.model;
    if (!model)
      throw new Error(
        `モデルが見つかりません: ${options.providerID}::${options.modelID}`,
      );

    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        signal: options.signal,
        maxRetries: 0,
        maxTokens: directCompletionMaxTokens(
          model,
          options.maxTokens,
          options.reasoning,
        ),
        temperature: Math.min(2, Math.max(0, options.temperature ?? 0.2)),
        reasoning: options.reasoning,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(
        response.errorMessage ||
          `生成が${response.stopReason === "aborted" ? "中断" : "失敗"}しました`,
      );
    }
    let text = "";
    for (const part of response.content) {
      if (part.type === "text") text += part.text;
    }
    text = text.trim();
    if (!text) throw new Error("プロバイダーの応答にテキストがありません");
    return text;
  } finally {
    if (manager) manager.release(heldAccountId!);
  }
}

export async function listProviderModelsCatalog(): Promise<
  ProviderModelsRow[]
> {
  await ensureRuntime();
  const state = readProviderModelState();
  const routingState = readProviderRouting();
  const rows: ProviderModelsRow[] = [];
  const accountRows: ProviderModelsRow[] = [];
  const accounts = listAccounts();
  const runtime = await getRuntimeFor();
  let agentDir: string | null = null;
  if (accounts.length > 0) {
    try {
      agentDir = await resolvePiAgentDir();
    } catch {
      // アカウント用認証ディレクトリを解決できない場合は共有行だけ返す
    }
  }
  if (runtime) {
    // マルチアカウント対応プロバイダーはアカウント専用。既定欄には出さない。
    rows.push(
      ...buildProviderModelsCatalog(runtime, state).filter(
        (row) => !runsThroughAccounts(row.id),
      ),
    );
  }

  if (agentDir) {
    const accountRowGroups = await Promise.all(
      accounts.map(async (account) => {
        const providerIds = storedAccountProviderIds(account, agentDir);
        if (providerIds.length === 0) return [];
        try {
          const accountRuntime = await getRuntimeFor(account.id);
          if (!accountRuntime) return [];
          const catalog = buildProviderModelsCatalog(
            accountRuntime,
            state,
            account.id,
          );
          return catalog
            .filter((row) => providerIds.includes(row.id as AccountProviderId))
            .map((row) => ({
              ...row,
              accountId: account.id,
              accountLabel: account.label,
            }));
        } catch {
          // 認証未完了・ランタイム初期化失敗のアカウントは一覧から省略する
          return [];
        }
      }),
    );
    accountRows.push(...accountRowGroups.flat());
  }

  const integratedRows = new Map<string, ProviderModelsRow[]>();
  const accountEntries: Array<
    { row: ProviderModelsRow } | { providerId: string }
  > = [];
  for (const row of accountRows) {
    if (
      isAccountRoutingProvider(row.id) &&
      accountRoutingMode(row.id, routingState) === "integrated"
    ) {
      const group = integratedRows.get(row.id) ?? [];
      if (group.length === 0) accountEntries.push({ providerId: row.id });
      group.push(row);
      integratedRows.set(row.id, group);
    } else {
      accountEntries.push({ row });
    }
  }
  for (const entry of accountEntries) {
    if ("row" in entry) {
      rows.push(entry.row);
      continue;
    }
    const merged = mergeIntegratedProviderRows(
      integratedRows.get(entry.providerId) ?? [],
      state,
    );
    if (merged) rows.push(merged);
  }

  const rowKey = (row: ProviderModelsRow) =>
    row.accountId ? accountProviderModelKey(row.id, row.accountId) : row.id;
  const hasAccountRowOrder = accountRows.some(
    (row) => row.accountId && state.providerOrder.includes(rowKey(row)),
  );
  const hasIntegratedRowOrder = rows.some(
    (row) =>
      !row.accountId &&
      isAccountRoutingProvider(row.id) &&
      accountRoutingMode(row.id, routingState) === "integrated" &&
      state.providerOrder.includes(row.id),
  );
  if (!hasAccountRowOrder && !hasIntegratedRowOrder) return rows;

  const orderIndex = new Map(
    state.providerOrder.map((key, index) => [key, index]),
  );
  const integratedRowRank = new Map<string, number>();
  for (const row of accountRows) {
    if (!row.accountId) continue;
    const rank = orderIndex.get(rowKey(row));
    if (rank === undefined) continue;
    const current = integratedRowRank.get(row.id);
    integratedRowRank.set(
      row.id,
      current === undefined ? rank : Math.min(current, rank),
    );
  }
  const rank = (row: ProviderModelsRow): number => {
    if (row.accountId && hasAccountRowOrder) {
      return orderIndex.get(rowKey(row)) ?? Number.MAX_SAFE_INTEGER;
    }
    if (!row.accountId) {
      return (
        orderIndex.get(row.id) ??
        integratedRowRank.get(row.id) ??
        Number.MAX_SAFE_INTEGER
      );
    }
    return orderIndex.get(row.id) ?? Number.MAX_SAFE_INTEGER;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

export async function setProviderOrModelEnabled(
  key: string,
  enabled: boolean,
  accountId?: string | null,
  modelIdsToDisableOnEnable?: readonly string[],
): Promise<void> {
  if (!key.trim())
    throw Object.assign(new Error("key が必要です"), { status: 400 });
  const normalizedAccountId = accountId?.trim() || undefined;
  const providerId = key.split("::", 1)[0];
  const childModelIds =
    enabled && !key.includes("::") ? modelIdsToDisableOnEnable : undefined;
  if (!normalizedAccountId && runsThroughAccounts(providerId)) {
    if (accountRoutingMode(providerId) !== "integrated") {
      throw Object.assign(
        new Error("このプロバイダーはアカウントIDが必要です"),
        { status: 400 },
      );
    }
    const accounts = listAccounts().filter((account) =>
      accountHasProvider(account, providerId),
    );
    if (accounts.length === 0) {
      throw Object.assign(new Error("ログインアカウントが見つかりません"), {
        status: 404,
      });
    }
    for (const account of accounts) {
      await setProviderModelDisabled(key, !enabled, account.id, childModelIds);
    }
    invalidateHealthCache();
    return;
  }
  if (normalizedAccountId) {
    const account = getAccount(normalizedAccountId);
    if (!account)
      throw Object.assign(new Error("アカウントが見つかりません"), {
        status: 404,
      });
    if (
      !isAccountProviderId(providerId) ||
      !accountHasProvider(account, providerId)
    ) {
      throw Object.assign(new Error("アカウントに紐づかないプロバイダーです"), {
        status: 400,
      });
    }
  }
  await setProviderModelDisabled(
    key,
    !enabled,
    normalizedAccountId,
    childModelIds,
  );
  invalidateHealthCache();
}

export async function saveProviderModelsOrder(input: {
  providerOrder?: string[];
  modelOrder?: Record<string, string[]>;
  accountModelOrder?: Record<string, Record<string, string[]>>;
}): Promise<void> {
  const modelOrder = { ...(input.modelOrder ?? {}) };
  const routingState = readProviderRouting();
  for (const [providerId, order] of Object.entries(modelOrder)) {
    if (
      !isAccountRoutingProvider(providerId) ||
      accountRoutingMode(providerId, routingState) !== "integrated"
    ) {
      continue;
    }
    delete modelOrder[providerId];
    for (const account of listAccounts()) {
      if (accountHasProvider(account, providerId)) {
        modelOrder[accountProviderModelKey(providerId, account.id)] = order;
      }
    }
  }
  if (input.accountModelOrder !== undefined) {
    if (
      typeof input.accountModelOrder !== "object" ||
      input.accountModelOrder === null ||
      Array.isArray(input.accountModelOrder)
    ) {
      throw Object.assign(new Error("accountModelOrder が不正です"), {
        status: 400,
      });
    }
    for (const [accountId, byProvider] of Object.entries(
      input.accountModelOrder,
    )) {
      const account = getAccount(accountId);
      if (!account)
        throw Object.assign(new Error("アカウントが見つかりません"), {
          status: 404,
        });
      if (
        typeof byProvider !== "object" ||
        byProvider === null ||
        Array.isArray(byProvider)
      ) {
        throw Object.assign(new Error("accountModelOrder が不正です"), {
          status: 400,
        });
      }
      for (const [providerId, order] of Object.entries(byProvider)) {
        if (
          !isAccountProviderId(providerId) ||
          !accountHasProvider(account, providerId)
        ) {
          throw Object.assign(
            new Error("アカウントに紐づかないプロバイダーです"),
            { status: 400 },
          );
        }
        if (
          !Array.isArray(order) ||
          order.some((id) => typeof id !== "string")
        ) {
          throw Object.assign(new Error("モデルの並び順が不正です"), {
            status: 400,
          });
        }
        modelOrder[accountProviderModelKey(providerId, accountId)] = order;
      }
    }
  }
  await setProviderModelOrder({
    providerOrder: input.providerOrder,
    modelOrder,
  });
  invalidateHealthCache();
}

export async function listProviderAuth(
  accountId?: string | null,
): Promise<ProviderAuthDto[]> {
  await ensureRuntime();
  const account = accountId ? getAccount(accountId) : undefined;
  if (accountId && !account) {
    throw Object.assign(new Error("アカウントが見つかりません"), {
      status: 404,
    });
  }
  const runtime = await getRuntimeFor(accountId);
  if (!runtime) return [];
  const storedAccountProviders = account
    ? new Set(
        storedAccountProviderIds(account, await resolvePiAgentDir()),
      )
    : null;
  const providers = runtime.getProviders().map((provider) => {
    const status = runtime.getProviderAuthStatus(provider.id);
    const methods = providerAuthMethods(provider);
    const accountScoped = Boolean(accountId) && isAccountProviderId(provider.id);
    const authenticated =
      status.configured &&
      (!accountScoped || storedAccountProviders?.has(provider.id) === true);
    return {
      id: provider.id,
      name: provider.name,
      authenticated,
      methods,
      authSource: authenticated ? status.source : undefined,
      authLabel: authenticated ? status.label : undefined,
      subscription: authenticated && runtime.isUsingSubscription(provider.id),
      oauthAvailable: methods.includes("oauth"),
      highlighted: isHighlightedProvider(provider.id),
      ...(isAccountRoutingProvider(provider.id)
        ? { accountRoutingMode: accountRoutingMode(provider.id) }
        : {}),
    } satisfies ProviderAuthDto;
  });
  if (!providers.some((provider) => provider.id === "opencode-go")) {
    // OpenCode Go is usage-only here; its account cookie is managed by the account panel.
    providers.push({
      id: "opencode-go",
      name: "OpenCode Go",
      authenticated: false,
      methods: [],
      authSource: undefined,
      authLabel: undefined,
      subscription: false,
      oauthAvailable: false,
      highlighted: true,
      accountRoutingMode: accountRoutingMode("opencode-go"),
    });
  }
  providers.sort((a, b) => {
    const score = (p: ProviderAuthDto) =>
      (p.highlighted ? 4 : 0) +
      (p.oauthAvailable ? 2 : 0) +
      (p.authenticated ? 1 : 0);
    return score(b) - score(a) || a.name.localeCompare(b.name, "en");
  });
  return providers;
}

export async function setProviderAccountRoutingMode(
  providerId: string,
  mode: AccountRoutingMode,
): Promise<void> {
  if (!isAccountRoutingProvider(providerId)) {
    throw Object.assign(
      new Error("このプロバイダーはアカウント統合に対応していません"),
      { status: 400 },
    );
  }
  await setAccountRoutingMode(providerId, mode);
  invalidateHealthCache();
}

export async function startProviderLogin(
  providerId: string,
  authType: AuthTypeDto,
  accountId?: string | null,
): Promise<{ sessionId: string }> {
  await ensureRuntime();
  if (accountId) {
    const account = getAccount(accountId);
    if (!account) {
      throw Object.assign(new Error("アカウントが見つかりません"), {
        status: 404,
      });
    }
    if (!accountHasProvider(account, providerId)) {
      throw Object.assign(new Error("アカウントに紐づかないプロバイダーです"), {
        status: 400,
      });
    }
  }
  const current = state();
  const runtime = await getRuntimeFor(accountId);
  if (!runtime)
    throw Object.assign(new Error("Pi runtime が初期化されていません"), {
      status: 503,
    });
  const provider = runtime.getProvider(providerId);
  if (!provider)
    throw Object.assign(new Error(`不明なプロバイダー: ${providerId}`), {
      status: 404,
    });
  const methods = providerAuthMethods(provider);
  if (!methods.includes(authType)) {
    throw Object.assign(
      new Error(
        `${provider.name} は ${authType === "oauth" ? "サブスクログイン" : "API キー"} に対応していません`,
      ),
      { status: 400 },
    );
  }
  if (current.loginSession) {
    current.loginSession.cancel();
    current.loginSession = null;
  }
  const session = new ProviderLoginSession(
    providerId,
    authType,
    accountId ?? null,
  );
  current.loginSession = session;
  // Let the SSE client attach before the OAuth flow emits prompts.
  queueMicrotask(() => {
    void session.run(runtime).finally(() => {
      // A login can change both models and account-scoped usage.
      invalidateHealthCache();
      invalidateCachedUsage();
      clearProviderCache(
        `${session.accountId ? `account:${session.accountId}` : "default"}:${session.providerId}`,
      );
      // Keep the finished session briefly so a late EventSource can replay history.
      setTimeout(() => {
        if (current.loginSession === session) current.loginSession = null;
      }, 15_000);
    });
  });
  return { sessionId: session.id };
}

export function answerProviderLogin(promptId: string, value: string): void {
  const session = state().loginSession;
  if (!session)
    throw Object.assign(new Error("ログインセッションがありません"), {
      status: 409,
    });
  session.answer(promptId, value);
}

export function cancelProviderLogin(): void {
  const current = state();
  current.loginSession?.cancel();
  current.loginSession = null;
}

export function subscribeProviderLogin(
  listener: (event: LoginSessionEvent) => void,
): () => void {
  const session = state().loginSession;
  if (!session)
    throw Object.assign(new Error("ログインセッションがありません"), {
      status: 409,
    });
  return session.subscribe(listener);
}

export function getActiveProviderLogin(): {
  sessionId: string;
  providerId: string;
  authType: AuthTypeDto;
  accountId: string | null;
} | null {
  const session = state().loginSession;
  if (!session) return null;
  return {
    sessionId: session.id,
    providerId: session.providerId,
    authType: session.authType,
    accountId: session.accountId,
  };
}

export async function logoutProvider(
  providerId: string,
  accountId?: string | null,
): Promise<void> {
  await ensureRuntime();
  if (accountId) {
    const account = getAccount(accountId);
    if (!account) {
      throw Object.assign(new Error("アカウントが見つかりません"), {
        status: 404,
      });
    }
    if (!accountHasProvider(account, providerId)) {
      throw Object.assign(new Error("アカウントに紐づかないプロバイダーです"), {
        status: 400,
      });
    }
  }
  const runtime = await getRuntimeFor(accountId);
  if (!runtime)
    throw Object.assign(new Error("Pi runtime が初期化されていません"), {
      status: 503,
    });
  if (!runtime.getProvider(providerId)) {
    throw Object.assign(new Error(`不明なプロバイダー: ${providerId}`), {
      status: 404,
    });
  }
  await runtime.logout(providerId);
  invalidateHealthCache();
  invalidateCachedUsage();
  clearProviderCache(
    `${accountId ? `account:${accountId}` : "default"}:${providerId}`,
  );
}

export { patchProject };

export function getProjects(includeArchived = false): ProjectDto[] {
  return listProjects(includeArchived);
}

export function addProject(rootPath: string): ProjectDto {
  const validated = validateProjectPath(rootPath);
  if (!validated.ok)
    throw Object.assign(new Error(validated.error), { status: 400 });
  return upsertProject({
    name: basename(validated.path) || "Untitled",
    rootPath: validated.path,
  });
}

export function archiveProject(id: string): ProjectDto {
  const project = patchProject(id, { archived: true });
  if (!project)
    throw Object.assign(new Error("プロジェクトが見つかりません"), {
      status: 404,
    });
  return project;
}

export function getTaskSummaries(includeArchived = false): TaskSummary[] {
  return listTasks(includeArchived).map(toSummary);
}

export function readTodoProgress(
  pi: PiModule,
  task: TaskSummary,
): TodoProgressDto | undefined {
  const sessionFile = task.sessionFile;
  if (!sessionFile) return undefined;
  try {
    const stat = statSync(sessionFile);
    const cached = todoProgressCache.get(sessionFile);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.value;
    }
    const sessionManager = pi.SessionManager.open(sessionFile);
    const progress = todoProgressFromTodos(
      todosFromPiMessages(sessionManager.buildSessionContext().messages),
    );
    todoProgressCache.set(sessionFile, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value: progress,
    });
    return progress;
  } catch {
    todoProgressCache.delete(sessionFile);
    return undefined;
  }
}

export async function getTaskSummariesWithTodoProgress(
  includeArchived = false,
): Promise<TaskSummary[]> {
  const summaries = getTaskSummaries(includeArchived);
  // アーカイブタスクは Sidebar の進捗表示対象外（TodoProgressBar は active のみ）。
  // 復元時は status が変わり再読込されるため、進捗の欠落は生じない。
  const coldTasks = summaries.filter(
    (task) =>
      task.status !== "archived" &&
      !state().live.has(task.id) &&
      task.sessionId,
  );
  const goalLoopByTaskId = new Map(
    coldTasks.flatMap((task) => {
      const goalLoopSummary = toGoalLoopSummary(
        readGoalLoopState(task.directory, task.sessionId),
      );
      return goalLoopSummary ? [[task.id, goalLoopSummary] as const] : [];
    }),
  );
  const tasksToRead = coldTasks.filter(
    (task) => !task.todoProgress && task.sessionFile,
  );

  let progressByTaskId = new Map<string, TodoProgressDto>();
  if (tasksToRead.length > 0) {
    try {
      const pi = await loadPi();
      progressByTaskId = new Map(
        tasksToRead.flatMap((task) => {
          const progress = readTodoProgress(pi, task);
          return progress ? [[task.id, progress] as const] : [];
        }),
      );
    } catch {
      // Goal Loop の状態は Pi セッションを開かずに返せるため、ここでは継続する。
    }
  }

  return summaries.map((task) => {
    const todoProgress = progressByTaskId.get(task.id);
    const goalLoopSummary = goalLoopByTaskId.get(task.id);
    return todoProgress || goalLoopSummary
      ? {
          ...task,
          ...(todoProgress ? { todoProgress } : {}),
          ...(goalLoopSummary ? { goalLoopSummary } : {}),
        }
      : task;
  });
}

/** Build the cheap first packet sent before a cold Pi session is hydrated. */
export function buildTaskBootstrap(
  task: TaskSummary,
  isStreaming = task.status === "working",
): TaskDetail {
  return {
    ...task,
    messages: [],
    isStreaming,
    isCompacting: false,
  };
}

export function getTaskBootstrap(id: string): TaskDetail {
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const live = state().live.get(id);
  return buildTaskBootstrap(
    task,
    live?.session.isStreaming ?? task.status === "working",
  );
}

export async function getTaskDetail(id: string): Promise<TaskDetail> {
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  let messages: UiMessage[] = [];
  let isStreaming = false;
  let isCompacting = false;
  let contextUsage: ContextUsageDto | undefined;
  let goalLoop: GoalLoopDto | null = null;
  let todos: TodoDto[] = [];
  try {
    const live = await ensureLive(id);
    const fields = sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    );
    messages = fields.messages;
    isStreaming = fields.isStreaming;
    isCompacting = fields.isCompacting;
    contextUsage = fields.contextUsage;
    goalLoop = fields.goalLoop;
    todos = fields.todos;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { status: 503 },
    );
  }
  return {
    ...toSummary(getTask(id) ?? task),
    messages,
    isStreaming,
    isCompacting,
    contextUsage,
    goalLoop,
    todos,
    permissionRequest: ensurePermissionPromptService().pendingForTask(id),
    questionRequest: ensureQuestionPromptService().pendingForTask(id),
  };
}

export async function goalLoopState(
  taskId: string,
): Promise<GoalLoopDto | null> {
  const live = await ensureLive(taskId);
  return readGoalLoopState(
    live.session.sessionManager.getCwd(),
    live.session.sessionId,
  );
}

export async function goalLoopCommand(
  taskId: string,
  input:
    | {
        action: "start";
        goal: string;
        acceptance?: string[];
        maxTurns?: number;
        cooldownSeconds?: number;
        forceFullRun?: boolean;
      }
    | { action: "pause" | "resume" | "stop" | "complete"; maxTurns?: number },
): Promise<GoalLoopDto | null> {
  const live = await ensureLive(taskId);
  let command: string;
  if (input.action === "start") {
    const payload = Buffer.from(
      JSON.stringify({
        goal: input.goal,
        acceptance: input.acceptance ?? [],
        maxTurns: input.maxTurns,
        cooldownSeconds: input.cooldownSeconds,
        forceFullRun: input.forceFullRun === true,
      }),
      "utf8",
    ).toString("base64url");
    command = `/goal-start ${payload}`;
  } else if (input.action === "resume" && input.maxTurns !== undefined) {
    command = `/goal-resume --turns ${Math.trunc(input.maxTurns)}`;
  } else {
    command = `/goal-${input.action}`;
  }
  await live.session.prompt(command);
  return readGoalLoopState(
    live.session.sessionManager.getCwd(),
    live.session.sessionId,
  );
}

export async function createTask(input: {
  projectId: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  images?: PromptImage[];
  agent?: string;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  skillPermission?: SkillPermission;
  /** 利用する認証アカウント（docs/plans/multi-account.md）。未指定 = 既定。 */
  accountId?: string;
  goalLoop?: {
    acceptance?: string[];
    maxTurns?: number;
    cooldownSeconds?: number;
    forceFullRun?: boolean;
  };
}): Promise<TaskSummary> {
  const project = getProject(input.projectId);
  if (!project)
    throw Object.assign(new Error("プロジェクトが見つかりません"), {
      status: 404,
    });
  const parsed = parseModelValue(input.model);
  const requestedAccountId = input.accountId?.trim() || parsed?.accountId;
  if (
    input.accountId &&
    parsed?.accountId &&
    input.accountId !== parsed.accountId
  ) {
    throw Object.assign(new Error("モデルとアカウントの指定が一致しません"), {
      status: 400,
    });
  }
  if (requestedAccountId && !getAccount(requestedAccountId)) {
    throw Object.assign(new Error("アカウントが見つかりません"), {
      status: 404,
    });
  }
  if (
    requestedAccountId &&
    parsed &&
    !isAccountRoutingProvider(parsed.providerID)
  ) {
    throw Object.assign(
      new Error("共有プロバイダーにはアカウントを指定できません"),
      { status: 400 },
    );
  }
  const insertStoredTask = (
    model: Model | undefined,
    accountId: string | null,
  ): TaskSummary => {
    const selectedIds = modelId(model);
    return insertTask({
      project,
      title: titleFromPrompt(input.prompt),
      thinkingLevel: input.thinkingLevel,
      providerID: selectedIds.providerID ?? parsed?.providerID,
      modelID: selectedIds.modelID ?? parsed?.modelID,
      ...(accountId ? { accountId } : {}),
      ...(input.agent ? { agent: input.agent.trim() } : {}),
      ...(input.skillPermission
        ? { skillPermission: input.skillPermission }
        : {}),
    });
  };
  let modelRoute: ConcreteModelRoute | undefined;
  let concreteAccountId = requestedAccountId ?? null;
  let reservedAccount: { providerID: string; accountId: string } | undefined;
  let task: TaskSummary;
  if (input.model) {
    const routed = await withRouteLock(
      `${parsed?.providerID ?? "default"}::${parsed?.modelID ?? "default"}`,
      async () => {
        const route = await resolveConcreteModel(
          input.model,
          requestedAccountId ?? null,
          {
            strictAccountId: true,
          },
        );
        if (!route)
          throw Object.assign(new Error("モデルが見つかりません"), {
            status: 400,
          });
        if (
          route.accountId &&
          parsed &&
          isAccountRoutingProvider(parsed.providerID)
        ) {
          reserveRoute(parsed.providerID, route.accountId);
        }
        try {
          patchProject(project.id, { lastOpenedAt: new Date().toISOString() });
          return {
            route,
            task: insertStoredTask(route.model, route.accountId),
          };
        } catch (error) {
          if (
            route.accountId &&
            parsed &&
            isAccountRoutingProvider(parsed.providerID)
          ) {
            releaseRoute(parsed.providerID, route.accountId);
          }
          throw error;
        }
      },
    );
    modelRoute = routed.route;
    concreteAccountId = routed.route.accountId;
    if (
      modelRoute.accountId &&
      parsed &&
      isAccountRoutingProvider(parsed.providerID)
    ) {
      reservedAccount = {
        providerID: parsed.providerID,
        accountId: modelRoute.accountId,
      };
    }
    task = routed.task;
  } else {
    patchProject(project.id, { lastOpenedAt: new Date().toISOString() });
    task = insertStoredTask(undefined, concreteAccountId);
  }
  const model = modelRoute?.model;
  const requestedThinking = isThinkingLevel(input.thinkingLevel)
    ? input.thinkingLevel
    : "off";
  const thinkingLevel = model
    ? clampThinkingLevelForModel(model, requestedThinking)
    : requestedThinking;
  try {
    const setup = await createSession({
      cwd: project.rootPath,
      sessionName: task.title,
      accountId: concreteAccountId,
      model,
      thinkingLevel,
      subagentPermission: input.subagentPermission,
      permissionMode: input.permissionMode,
      skillPermission: input.skillPermission,
      // The selected agent talks as the main persona for this whole session.
      agentName: input.agent ?? null,
    });
    patchTask(task.id, {
      sessionId: setup.session.sessionId,
      sessionFile: setup.session.sessionFile,
      status: "working",
      thinkingLevel: isThinkingLevel(setup.session.thinkingLevel)
        ? setup.session.thinkingLevel
        : thinkingLevel,
      ...modelId(setup.session.model),
    });
    const live = await attachSession(
      task.id,
      setup.session,
      setup.skillPermissionRef,
    );
    if (input.goalLoop) {
      await goalLoopCommand(task.id, {
        action: "start",
        goal: input.prompt,
        acceptance: input.goalLoop.acceptance,
        maxTurns: input.goalLoop.maxTurns,
        cooldownSeconds: input.goalLoop.cooldownSeconds,
        forceFullRun: input.goalLoop.forceFullRun,
      });
    } else {
      queuePrompt(live, input.prompt, input.images, {
        agent: input.agent,
        subagentPermission: input.subagentPermission,
        permissionMode: input.permissionMode,
      });
    }
    return toSummary(getTask(task.id) ?? task);
  } finally {
    if (reservedAccount) {
      releaseRoute(reservedAccount.providerID, reservedAccount.accountId);
    }
  }
}

/**
 * Open the same transcript with a newly selected account. Pi binds the model
 * runtime to AgentSession, so changing accounts between turns requires a
 * session replacement rather than an in-place model mutation.
 */
async function replaceLiveForRoute(
  live: LiveRuntime,
  task: TaskSummary,
  route: ConcreteModelRoute,
): Promise<LiveRuntime> {
  const project = getProject(task.projectId);
  const sessionFile = live.session.sessionFile ?? task.sessionFile;
  if (!sessionFile) {
    throw new Error("セッションを別アカウントへ切り替えられません");
  }
  const thinkingLevel = clampThinkingLevelForModel(
    route.model,
    isThinkingLevel(live.session.thinkingLevel)
      ? live.session.thinkingLevel
      : task.thinkingLevel,
  );
  const setup = await createSession({
    cwd: project?.rootPath ?? task.directory,
    sessionFile,
    sessionName: task.title,
    accountId: route.accountId,
    model: route.model,
    thinkingLevel,
    skillPermission: live.skillPermission,
    agentName: task.agent ?? null,
  });

  const updatedTask = patchTask(task.id, {
    accountId: route.accountId ?? undefined,
    providerID: task.providerID,
    modelID: task.modelID,
    thinkingLevel,
  });
  if (!updatedTask) {
    setup.session.dispose();
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  }

  try {
    return await attachSession(task.id, setup.session, setup.skillPermissionRef);
  } catch (error) {
    setup.session.dispose();
    // attachSession acquires the new runtime before replacing the old live
    // session. Restore the persisted identity if acquisition failed.
    patchTask(task.id, {
      accountId: task.accountId,
      providerID: task.providerID,
      modelID: task.modelID,
      thinkingLevel: task.thinkingLevel,
    });
    throw error;
  }
}

/** Select a fresh integrated account before a queued/next user turn. */
async function prepareLiveForPrompt(
  live: LiveRuntime,
  reroute: boolean,
): Promise<LiveRuntime> {
  const currentLive = state().live.get(live.taskId) ?? live;
  const task = getTask(currentLive.taskId);
  const canRoute = Boolean(
    reroute &&
      task?.providerID &&
      task.modelID &&
      isAccountRoutingProvider(task.providerID) &&
      accountRoutingMode(task.providerID) === "integrated" &&
      !currentLive.session.isStreaming &&
      currentLive.session.messages.some((message) => message.role === "user"),
  );
  if (!canRoute || !task?.providerID || !task.modelID) {
    setTaskStatus(currentLive.taskId, "working");
    return currentLive;
  }

  return withRouteLock(
    `${task.providerID}::${task.modelID}`,
    async () => {
      const latestLive = state().live.get(task.id) ?? currentLive;
      const latestTask = getTask(task.id);
      if (!latestTask) {
        throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
      }
      if (
        !latestTask.providerID ||
        !latestTask.modelID ||
        !isAccountRoutingProvider(latestTask.providerID) ||
        accountRoutingMode(latestTask.providerID) !== "integrated" ||
        latestLive.session.isStreaming ||
        !latestLive.session.messages.some((message) => message.role === "user")
      ) {
        setTaskStatus(latestTask.id, "working");
        return latestLive;
      }

      const route = await resolveIntegratedModelRoute(
        latestTask.providerID,
        latestTask.modelID,
      );
      if (!route) {
        throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
      }

      const nextLive =
        route.accountId === (latestTask.accountId ?? null)
          ? latestLive
          : await replaceLiveForRoute(latestLive, latestTask, route);
      setTaskStatus(latestTask.id, "working");
      if (nextLive !== latestLive) {
        emitTaskSnapshot(nextLive, "account_routed");
      }
      return nextLive;
    },
  );
}

function queuePrompt(
  live: LiveRuntime,
  prompt: string,
  images?: PromptImage[],
  meta?: {
    agent?: string;
    subagentPermission?: "allow" | "deny";
    permissionMode?: "allow" | "ask" | "deny";
    isHangRetry?: boolean;
    streamingBehavior?: "steer" | "followUp";
  },
): void {
  applySubagentPermission(live.session, meta?.subagentPermission);
  const isHangRetry =
    meta?.isHangRetry === true || prompt.startsWith(HANG_RETRY_PREFIX);
  live.manualAbortedAssistantId = null;
  armTaskHangWatch({
    taskId: live.taskId,
    prompt,
    images,
    ...(meta?.agent ? { agent: meta.agent } : {}),
    ...(meta?.subagentPermission
      ? { subagentPermission: meta.subagentPermission }
      : {}),
    ...(meta?.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    isHangRetry,
  });
  let activeLive = live;
  const runPrompt = async () => {
    activeLive = await prepareLiveForPrompt(live, !meta?.streamingBehavior);
    applySubagentPermission(activeLive.session, meta?.subagentPermission);
    if (meta?.permissionMode) {
      const task = getTask(activeLive.taskId);
      const project = task ? getProject(task.projectId) : undefined;
      applyPermissionMode(
        activeLive.session,
        project?.rootPath ?? activeLive.session.sessionManager.getCwd(),
        meta.permissionMode,
      );
    }
    const options: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      streamingBehavior?: "steer" | "followUp";
    } = {};
    if (images && images.length > 0) {
      options.images = images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      }));
    }
    if (meta?.streamingBehavior) {
      options.streamingBehavior = meta.streamingBehavior;
    } else if (live.session.isStreaming) {
      options.streamingBehavior = "followUp";
    }
    try {
      await activeLive.session.prompt(prompt, options);
    } catch (error) {
      // 一部モデル（o系/gpt-5-pro 等）は思考オフ不可の 400 を返す。
      // 思考レベルを引き上げて同じプロンプトを一度だけ再試行する。
      if (!isReasoningMandatoryError(error) || activeLive.reasoningFallbackTried)
        throw error;
      activeLive.reasoningFallbackTried = true;
      const level = reasoningFallbackLevel(activeLive.session.model);
      if (activeLive.session.thinkingLevel !== level)
        activeLive.session.setThinkingLevel(level);
      patchTask(activeLive.taskId, { thinkingLevel: level });
      emitTaskSnapshot(activeLive, "thinking_level_changed", {
        thinkingLevel: level,
      });
      await activeLive.session.prompt(prompt, options);
    }
  };
  const handlePromptError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const currentLive = state().live.get(live.taskId) ?? activeLive;
    setTaskStatus(live.taskId, "error", message);
    emit(live.taskId, {
      type: "snapshot",
      task: toSummary(getTask(live.taskId)!),
      ...sessionSnapshotFields(
        currentLive.session,
        currentLive.throughputByStartedAt,
        currentLive.toolStartedAt,
        currentLive.toolEndedAt,
        currentLive.toolPartialOutputByCallId,
        { accountId: currentLive.accountId, byMessageId: currentLive.accountByMessageId },
      ),
      isStreaming: false,
      eventType: "error",
      error: message,
    });
  };
  // A steering request must reach the SDK while the current turn is still
  // running. The normal prompt chain is retained for idle submissions so two
  // simultaneous starts cannot race each other.
  if (
    meta?.streamingBehavior &&
    (live.session.isStreaming || live.promptActive)
  ) {
    void runPrompt().catch(handlePromptError);
    return;
  }
  live.promptActive = true;
  const promptChain = live.promptChain
    .then(runPrompt)
    .catch(handlePromptError)
    .finally(() => {
      // A queued prompt or a route switch may replace this live object's
      // prompt chain while the current promise is running.
      if (live.promptChain === promptChain) {
        live.promptActive = false;
      }
      if (activeLive !== live && activeLive.promptChain === promptChain) {
        activeLive.promptActive = false;
      }
    });
  live.promptChain = promptChain;
}

export async function promptTask(
  id: string,
  prompt: string,
  images?: PromptImage[],
  options?: {
    agent?: string;
    subagentPermission?: "allow" | "deny";
    permissionMode?: "allow" | "ask" | "deny";
    skillPermission?: SkillPermission;
    streamingBehavior?: "steer" | "followUp";
  },
): Promise<TaskSummary> {
  if (options?.agent !== undefined) {
    const task = getTask(id);
    if (!task)
      throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
    const requestedAgent = options.agent.trim();
    const currentAgent = task.agent?.trim() ?? "";
    if (requestedAgent !== currentAgent) {
      await setTaskAgent(id, options.agent);
    }
  }
  const live = await ensureLive(id);
  applySubagentPermission(live.session, options?.subagentPermission);
  if (options?.skillPermission)
    await applyLiveSkillPermission(live, options.skillPermission);
  if (options?.permissionMode) {
    const task = getTask(id);
    const project = task ? getProject(task.projectId) : undefined;
    const cwd = project?.rootPath ?? live.session.sessionManager.getCwd();
    applyPermissionMode(live.session, cwd, options.permissionMode);
  }
  live.revertLeafId = null;
  queuePrompt(live, prompt, images, {
    agent: options?.agent,
    subagentPermission: options?.subagentPermission,
    permissionMode: options?.permissionMode,
    streamingBehavior: options?.streamingBehavior,
  });
  return toSummary(getTask(id)!);
}

async function applyLiveSkillPermission(
  live: LiveRuntime,
  permission: SkillPermission,
): Promise<void> {
  if (permission === live.skillPermission) return;
  const previous = live.skillPermissionRef.current;
  live.skillPermissionRef.current = permission;
  try {
    await live.session.reload();
    live.skillPermission = permission;
  } catch (error) {
    live.skillPermissionRef.current = previous;
    throw error;
  }
}

export async function setTaskSkillPermission(
  id: string,
  permission: SkillPermission,
): Promise<TaskSummary> {
  const live = await ensureLive(id);
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  await applyLiveSkillPermission(live, permission);
  return patchTask(id, { skillPermission: permission }) ?? task;
}

export async function setTaskPermissionMode(
  id: string,
  mode: "allow" | "ask" | "deny",
): Promise<TaskSummary> {
  const live = await ensureLive(id);
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const project = getProject(task.projectId);
  const cwd = project?.rootPath ?? live.session.sessionManager.getCwd();
  applyPermissionMode(live.session, cwd, mode);
  return toSummary(task);
}

/**
 * 既存セッションの active tools を更新し、サブエージェント許可を機械的に強制する。
 * 禁止時は `subagent` ツールを除外、許可時は追加する。
 */
export function applySubagentPermission(
  session: AgentSession,
  permission: "allow" | "deny" | undefined,
): void {
  const effective = permission ?? "deny";
  if (
    typeof session.setActiveToolsByName !== "function" ||
    typeof session.getActiveToolNames !== "function"
  ) {
    return;
  }
  const current = session.getActiveToolNames();
  const hasSubagent = current.includes("subagent");
  if (effective === "allow" && !hasSubagent) {
    session.setActiveToolsByName([...current, "subagent"]);
  } else if (effective === "deny" && hasSubagent) {
    session.setActiveToolsByName(current.filter((tool) => tool !== "subagent"));
  }
}

/** Stop detached async children before aborting the parent Pi turn. */
async function stopSubagentRunsForTask(
  live: LiveRuntime,
  messages: UiMessage[],
): Promise<void> {
  const command = live.session.extensionRunner.getCommand("subagents-stop");
  if (!command) return;
  let sinceMs: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      // Artifact mtime and message timestamps can differ slightly on Windows.
      sinceMs = Math.max(0, message.createdAt - 5_000);
      break;
    }
  }
  try {
    const runs = listSubagentRuns({
      sessionFile: live.session.sessionFile,
      cwd: live.session.sessionManager.getCwd(),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
    });
    const result = await stopRunningSubagentRuns(runs, async (runId) =>
      command.handler(
        runId,
        live.session.extensionRunner.createCommandContext(),
      ),
    );
    if (result.failed.length > 0) {
      console.warn(
        `[subagent] failed to stop runs: ${result.failed.join(", ")}`,
      );
    }
  } catch (error) {
    // Parent abort must remain available even when an artifact or extension is unavailable.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[subagent] failed to enumerate running children: ${reason}`);
  }
}

export async function abortTask(id: string): Promise<TaskSummary> {
  const live = state().live.get(id);
  if (live) {
    const msgs = snapshotMessages(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
    );
    let promptIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === "user") {
        promptIndex = i;
        break;
      }
    }
    const turnAssistants =
      promptIndex >= 0
        ? msgs.slice(promptIndex + 1).filter((m) => m.role === "assistant")
        : [];
    live.manualAbortedAssistantId = turnAssistants.at(-1)?.id ?? "";
    await stopSubagentRunsForTask(live, msgs);
    await live.session.abort();
    emitTaskSnapshot(live, "abort");
  }
  const task = setTaskStatus(id, "idle");
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return toSummary(task);
}

export async function setTaskAgent(
  id: string,
  agentName: string,
): Promise<TaskSummary> {
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });

  const normalized = agentName.trim();
  if (normalized && !loadAgentDefinition(normalized)) {
    throw Object.assign(new Error("エージェントが見つかりません"), {
      status: 400,
    });
  }
  if (normalized === (task.agent?.trim() ?? "")) return toSummary(task);

  const live = await ensureLive(id);
  if (live.session.isStreaming) {
    throw Object.assign(new Error("実行中タスクのエージェントは変更できません"), {
      status: 409,
    });
  }

  // Agent resource options are fixed when a session is created. Reopen the
  // same transcript with the new persona on the next prompt.
  disposeLive(id);
  const updatedTask = patchTask(id, { agent: normalized || null });
  if (!updatedTask)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const summary = toSummary(updatedTask);
  emit(id, { type: "snapshot", task: summary, eventType: "agent_changed" });
  return summary;
}

export async function setTaskModel(
  id: string,
  modelValueRaw: string,
): Promise<TaskSummary> {
  const task = getTask(id);
  const parsed = parseModelValue(modelValueRaw);
  if (!task || !parsed) {
    throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  }
  const modelRoute = await withRouteLock(
    `${parsed.providerID}::${parsed.modelID}`,
    () => resolveConcreteModel(modelValueRaw, parsed.accountId ?? null),
  );
  if (!modelRoute)
    throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  const targetAccountId = modelRoute.accountId;
  const model = modelRoute.model;
  const levels = thinkingLevelsForModel(model);

  // アカウント切替はセッションの再作成が必要。実行中（ストリーミング中）は拒否し、
  // それ以外は live セッションを破棄して次回 ensureLive で新しいランタイムから作る。
  // 先に ensureLive を待って作成中セッションとの競合をなくす。
  if (targetAccountId !== (task.accountId ?? null)) {
    const live = await ensureLive(id);
    if (live.session.isStreaming) {
      throw Object.assign(
        new Error("実行中タスクのアカウントは変更できません"),
        { status: 409 },
      );
    }
    disposeLive(id);
    const current = isThinkingLevel(task.thinkingLevel)
      ? task.thinkingLevel
      : "off";
    const thinkingLevel = levels.includes(current)
      ? current
      : defaultThinkingLevel(levels);
    const updatedTask = patchTask(id, {
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      thinkingLevel,
      accountId: targetAccountId ?? undefined,
    });
    if (!updatedTask)
      throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
    const summary = toSummary(updatedTask);
    emit(id, { type: "snapshot", task: summary });
    return summary;
  }

  const live = await ensureLive(id);
  await live.session.setModel(model);
  const ids = modelId(live.session.model ?? model);
  const current = isThinkingLevel(live.session.thinkingLevel)
    ? live.session.thinkingLevel
    : getTask(id)?.thinkingLevel;
  // 現レベルが新モデルでも有効なら維持、無ければ既定（medium 相当）へ。
  // clampThinkingLevel は上位レベルへ昇格するため使わない。
  const thinkingLevel =
    current && levels.includes(current)
      ? current
      : defaultThinkingLevel(levels);
  if (live.session.thinkingLevel !== thinkingLevel) {
    live.session.setThinkingLevel(thinkingLevel);
  }
  const updatedTask = patchTask(id, {
    providerID: ids.providerID ?? parsed.providerID,
    modelID: ids.modelID ?? parsed.modelID,
    thinkingLevel,
  });
  if (!updatedTask)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const summary = toSummary(updatedTask);
  emit(id, {
    type: "snapshot",
    task: summary,
    ...sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    ),
  });
  return summary;
}

export async function setTaskThinkingLevel(
  id: string,
  levelRaw: string,
): Promise<TaskSummary> {
  if (!isThinkingLevel(levelRaw)) {
    throw Object.assign(new Error("thinkingLevel が不正です"), { status: 400 });
  }
  const live = await ensureLive(id);
  live.session.setThinkingLevel(levelRaw);
  const thinkingLevel = isThinkingLevel(live.session.thinkingLevel)
    ? live.session.thinkingLevel
    : levelRaw;
  const task = patchTask(id, { thinkingLevel });
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const summary = toSummary(task);
  emit(id, {
    type: "snapshot",
    task: summary,
    ...sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    ),
  });
  return summary;
}

export async function compactTask(
  id: string,
  customInstructions?: string,
): Promise<TaskDetail> {
  const live = await ensureLive(id);
  if (live.session.isCompacting) {
    throw Object.assign(new Error("コンテキスト圧縮は既に実行中です"), {
      status: 409,
    });
  }
  const instructions = customInstructions?.trim();
  try {
    await live.session.compact(instructions || undefined);
  } catch (error) {
    throw mapCompactionError(error);
  }
  return getTaskDetail(id);
}

export async function abortTaskCompaction(id: string): Promise<TaskDetail> {
  const live = state().live.get(id);
  if (!live)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  live.session.abortCompaction();
  return getTaskDetail(id);
}

/**
 * 巻き戻し: 指定ユーザーメッセージ（UI のメッセージ id）以降を破棄し、その
 * 内容を text / images として返す（本家 LeafCode の「入力欄に戻す」と同じ）。
 * Pi コアの navigateTree は user メッセージをターゲットにすると leaf を親へ
 * 移し、破棄した分の入力を editorText として返す。
 */
export async function revertTask(
  id: string,
  messageId: string,
): Promise<{
  task: TaskDetail;
  text: string;
  images: { uri: string; mime: string; name?: string }[];
}> {
  const live = await ensureLive(id);
  if (live.session.isStreaming) {
    throw Object.assign(
      new Error("応答中は巻き戻せません。停止してからお試しください"),
      {
        status: 409,
      },
    );
  }
  const entry = messageEntryById(live.session, messageId);
  if (!entry) {
    throw Object.assign(new Error("対象メッセージが見つかりません"), {
      status: 404,
    });
  }
  if (entry.message.role !== "user") {
    throw Object.assign(new Error("ユーザーメッセージのみ入力欄に戻せます"), {
      status: 400,
    });
  }
  const previousLeafId = live.session.sessionManager.getLeafId();
  const result = await live.session.navigateTree(entry.id);
  if (result.cancelled) {
    throw Object.assign(new Error("巻き戻しがキャンセルされました"), {
      status: 400,
    });
  }
  live.revertLeafId = captureRevertLeafId(previousLeafId);
  const taskDetail = await getTaskDetail(id);
  emit(id, {
    type: "snapshot",
    task: toSummary(getTask(id)!),
    ...sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    ),
    eventType: "revert",
  });
  return {
    task: taskDetail,
    text: result.editorText ?? "",
    images: imagesFromEntry(entry),
  };
}

/** UI のメッセージ id からセッションエントリを取り出す。 */
export function messageEntryById(
  session: AgentSession,
  messageId: string,
): { id: string; message: { role: string; content: unknown } } | null {
  try {
    const entries = session.sessionManager.getEntries();
    // 通常経路: snapshotMessages が UiMessage.id へ設定したエントリ id
    for (const entry of entries) {
      if (entry.type !== "message" || entry.id !== messageId) continue;
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object") continue;
      return {
        id: entry.id,
        message: message as { role: string; content: unknown },
      };
    }
    // フォールバック: 旧スナップショットの仮 id `msg-N`（ブランチ上のメッセージ順）
    const fallback = /^msg-(\d+)$/.exec(messageId);
    if (fallback) {
      const branch = entries.filter((entry) => entry.type === "message");
      const entry = branch[Number(fallback[1])];
      const message = entry
        ? (entry as { message?: unknown }).message
        : undefined;
      if (entry && message && typeof message === "object") {
        return {
          id: entry.id,
          message: message as { role: string; content: unknown },
        };
      }
    }
  } catch {
    /* session may not expose entries yet */
  }
  return null;
}

/** user エントリの image ブロックを Composer 添付相当に変換する。 */
export function imagesFromEntry(entry: {
  message: { role: string; content: unknown };
}): { uri: string; mime: string; name?: string }[] {
  const content = Array.isArray(entry.message.content)
    ? entry.message.content
    : [];
  const images: { uri: string; mime: string; name?: string }[] = [];
  content.forEach((block, index) => {
    if (!block || typeof block !== "object") return;
    const record = block as {
      type?: unknown;
      mimeType?: unknown;
      data?: unknown;
      filename?: unknown;
    };
    if (record.type !== "image") return;
    const data = typeof record.data === "string" ? record.data : "";
    if (!data) return;
    const mime =
      typeof record.mimeType === "string" && record.mimeType
        ? record.mimeType
        : "image/png";
    images.push({
      uri: `data:${mime};base64,${data}`,
      mime,
      ...(typeof record.filename === "string" && record.filename
        ? { name: record.filename }
        : { name: `image-${index + 1}` }),
    });
  });
  return images;
}

/** unrevert 用: navigateTree の前に leaf id を保存する（後だと巻き戻し後の位置になる）。 */
export function captureRevertLeafId(
  leafIdBeforeNavigate: string | null,
): string | null {
  return leafIdBeforeNavigate;
}

/** 巻き戻し取消: revert 前の leaf へ戻す。 */
export async function unrevertTask(id: string): Promise<TaskDetail> {
  const live = state().live.get(id);
  if (!live)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const target = live.revertLeafId;
  if (!target) {
    throw Object.assign(new Error("巻き戻しの対象がありません"), {
      status: 400,
    });
  }
  live.revertLeafId = null;
  await live.session.navigateTree(target);
  const taskDetail = await getTaskDetail(id);
  emit(id, {
    type: "snapshot",
    task: toSummary(getTask(id)!),
    ...sessionSnapshotFields(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
      live.toolPartialOutputByCallId,
      { accountId: live.accountId, byMessageId: live.accountByMessageId },
    ),
    eventType: "unrevert",
  });
  return taskDetail;
}

export async function getCompactionSettings(): Promise<CompactionSettingsDto> {
  await ensureRuntime();
  return openSettingsManager().getCompactionSettings();
}

export async function setCompactionEnabled(
  enabled: boolean,
): Promise<CompactionSettingsDto> {
  await ensureRuntime();
  const settings = openSettingsManager();
  settings.setCompactionEnabled(enabled);
  await settings.flush();
  for (const live of state().live.values()) {
    live.session.setAutoCompactionEnabled(enabled);
  }
  return settings.getCompactionSettings();
}

export function archiveTask(id: string): TaskSummary {
  disposeLive(id);
  const task = setTaskStatus(id, "archived");
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return task;
}

export function restoreTask(id: string): TaskSummary {
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  if (task.status !== "archived")
    throw Object.assign(new Error("アーカイブされたタスクのみ復元できます"), {
      status: 400,
    });
  return patchTask(id, { status: "idle" }) ?? task;
}

export function destroyTask(id: string): { ok: true } {
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  disposeLive(id);
  deleteTask(id);
  return { ok: true };
}

export function destroyArchivedTasksByProject(projectId: string): {
  ok: true;
  removed: number;
} {
  const tasks = listTasks(true).filter(
    (task) => task.projectId === projectId && task.status === "archived",
  );
  for (const task of tasks) {
    disposeLive(task.id);
    deleteTask(task.id);
  }
  return { ok: true, removed: tasks.length };
}

export function restoreProject(id: string): ProjectDto {
  const project = patchProject(id, { archived: false });
  if (!project)
    throw Object.assign(new Error("プロジェクトが見つかりません"), {
      status: 404,
    });
  return project;
}

export function destroyProject(id: string): { ok: true } {
  const project = getProject(id);
  if (!project)
    throw Object.assign(new Error("プロジェクトが見つかりません"), {
      status: 404,
    });
  const tasks = listTasks(true).filter((task) => task.projectId === id);
  for (const task of tasks) {
    disposeLive(task.id);
    deleteTask(task.id);
  }
  deleteProjectRecord(id);
  return { ok: true };
}

/**
 * Reload AGENTS.md / skills / extensions into every in-memory AgentSession
 * (Pi's `/reload`). Next prompt uses the updated system prompt.
 */
export async function reloadLiveSessionsContext(): Promise<{
  reloaded: number;
  failed: number;
  errors: string[];
}> {
  const lives = [...state().live.values()];
  let reloaded = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const live of lives) {
    try {
      await live.session.reload();
      reloaded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${live.taskId}: ${message}`);
    }
  }
  return { reloaded, failed, errors };
}

export function subscribeTask(
  id: string,
  listener: (payload: Record<string, unknown>) => void,
): () => void {
  const handler = (payload: Record<string, unknown>) => listener(payload);
  state().events.on(id, handler);
  return () => {
    state().events.off(id, handler);
  };
}

export function pendingPermissionForTask(
  taskId: string,
): PermissionRequestDto | null {
  return ensurePermissionPromptService().pendingForTask(taskId);
}

export function respondToPermissionPrompt(
  taskId: string,
  requestId: string,
  approved: boolean,
): boolean {
  return ensurePermissionPromptService().respond(taskId, requestId, approved);
}

export function pendingQuestionForTask(
  taskId: string,
): QuestionRequestDto | null {
  return ensureQuestionPromptService().pendingForTask(taskId);
}

export function respondToQuestionPrompt(
  taskId: string,
  requestId: string,
  answer: QuestionAnswer | null,
): boolean {
  return ensureQuestionPromptService().respond(taskId, requestId, answer);
}

/** 注意喚起が必要なタスク一覧（GlobalAttentionProvider のポーリング応答）。 */
export function listPendingAttention(): AttentionItemDto[] {
  const items: AttentionItemDto[] = [];
  // 待機中タスクはサービスが保持するキーのみで判別できる。全タスク走査は不要。
  const permissionIds = ensurePermissionPromptService().pendingTaskIds();
  const questionIds = ensureQuestionPromptService().pendingTaskIds();
  const candidateIds = new Set<string>();
  for (const id of permissionIds) candidateIds.add(id);
  for (const id of questionIds) candidateIds.add(id);
  if (candidateIds.size === 0) return items;
  // 必要なのは id/title のみ。toSummary はライブタスクでメッセージ走査を伴うため、
  // store の生レコードを直接使う（4 秒間隔ポーリングのコスト削減）。
  for (const task of listTasks(false)) {
    if (!candidateIds.has(task.id)) continue;
    const kinds: AttentionItemDto["kinds"] = [];
    if (permissionIds.has(task.id)) kinds.push("permission");
    if (questionIds.has(task.id)) kinds.push("question");
    if (kinds.length > 0)
      items.push({ taskId: task.id, title: task.title, kinds });
  }
  return items;
}

export function jsonError(
  error: unknown,
  fallbackStatus = 500,
): { error: string; status: number } {
  const status =
    typeof error === "object" &&
    error &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : fallbackStatus;
  return {
    error: error instanceof Error ? error.message : String(error),
    status,
  };
}
