import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dataDir,
  isAbsolutePath,
  noProjectRoot,
  pathKey,
  sameOrDescendantPath,
  samePath,
} from "@/lib/paths";
import { prepareWorkspaceMove, type PreparedWorkspaceMove } from "@/lib/workspace-move";
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
  type ProviderModelSnapshot,
  type ProviderModelsRow,
} from "@/lib/provider-models";
import {
  accountProviderModelKey,
  contextWindowForModel,
  ensureProviderModelsKnown,
  readProviderModelState,
  setProviderModelDisabled,
  setProviderModelOrder,
  sortByPreferredOrder,
  type ProviderModelRef,
} from "@/lib/provider-model-state";
import {
  registerLlamaProviders,
  syncLlamaServerProvider,
} from "@/lib/pi/llama-provider";
import { registerCursorProvider } from "@/lib/pi/cursor-provider";
import { registerCommandCodeProvider } from "@/lib/pi/commandcode-provider";
import {
  registerRemoteProvider,
  syncRemoteProvider,
} from "@/lib/pi/remote-provider";
import {
  registerOllamaCloudProvider,
  syncOllamaCloudProvider,
} from "@/lib/pi/ollama-cloud-provider";
import {
  effectiveBaseUrl,
  isEditableBaseUrlProvider,
  setProviderBaseUrl as setProviderBaseUrlFromEndpoints,
} from "@/lib/provider-endpoints";
import { readGoalLoopState } from "@/lib/pi/goal-loop-state";
import {
  todoProgressFromTodos,
  todosFromPiMessages,
} from "@/lib/pi/todowrite-state";
import { toContextUsageDto, type ContextUsageDto } from "@/lib/context-usage";
import {
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
  parseCompactionAction,
  parseCompactionThreshold,
  reserveTokensForThreshold,
  shouldCompactAtThreshold,
} from "@/lib/compaction-settings";
import { compactSkillsForPrompt, filterSkillsByState } from "@/lib/skills";
import type { SkillPermission } from "@/lib/skill-permission";
import {
  needsToolSearch,
  registerDeferredTools,
  TOOL_SEARCH_NAME,
} from "@/lib/pi/deferred-tools";
import { sessionIdentityPatch } from "@/lib/pi/session-identity";
import {
  basenameKey,
  bundledExtensionEntries,
  filterExtensionsByState,
} from "@/lib/extensions";
import {
  applyPermissionMode,
  readPermissionGateConfig,
} from "@/lib/permission-gate-config";
import { buildAgentResourceOptions, loadAgentDefinition } from "@/lib/agents";
import {
  armTaskHangWatch,
  disarmTaskHangWatch,
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
import { getSetting } from "@/lib/pi/web-settings";
import { listSubagentRuns } from "@/lib/pi/subagent-runs";
import { stopRunningSubagentRuns } from "@/lib/pi/stop-subagent-runs";
import { getCachedUsage, invalidateCachedUsage } from "@/lib/codexbar/cache";
import type { CodexBarProvider } from "@/lib/codexbar";
import {
  autoProviderUsageFromModels,
  chooseAutoModel,
  classifyPrompt,
  type AutoDecision,
  type AutoOptimizeMode,
  type AutoRouteConfig,
} from "@/lib/auto-model";
import { clearProviderCache } from "@/lib/codexbar/provider-cache";
import {
  accountRoutingMode,
  chooseRoutingCandidate,
  clearProviderLimit,
  isAccountRoutingProvider,
  isProviderLimitError,
  markProviderLimited,
  providerLimitMark,
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
type SessionPromptOptions = NonNullable<Parameters<AgentSession["prompt"]>[1]>;
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
  /** Compaction started after the last settled response; prompts wait for it. */
  autoCompactionPromise: Promise<void> | null;
  /** Prevent the settled event from starting auto-compaction during a manual abort. */
  manualCompactionInProgress: boolean;
  /** Native Pi compaction already ran during the current agent run. */
  nativeCompactionAttempted: boolean;
  /** The current agent run belongs to an active Goal Loop turn. */
  goalLoopTurnActive: boolean;
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
  /** pending がフルスナップショット待ちか（delta 待ちとの区別）。 */
  pendingSnapshotIsDelta: boolean;
  /** フルスナップショットに付与する追加フィールド（error 等）。 */
  pendingSnapshotExtra: Record<string, unknown> | undefined;
  /** Session entry id the last navigateTree moved the leaf to (for undo). */
  revertLeafId: string | null;
  /** POST /abort で中断したターンの assistant メッセージ ID。 */
  manualAbortedAssistantId: string | null;
  /** 直近のハング自動再開回数（UI 通知用）。 */
  hangRetryCount: number;
  /** 「Reasoning is mandatory」400 で思考 ON に上げて再試行済みか。 */
  reasoningFallbackTried: boolean;
  /** A provider-limit response is handled at the next safe turn boundary. */
  pendingProviderFallback: {
    providerID: string;
    modelID: string;
    message: string;
  } | null;
  /** Restore the user's retry setting after suppressing a duplicate limit retry. */
  restoreAutoRetry: boolean;
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
  accountRecordsCache: AccountModelRecordCacheEntry | null;
  accountRecordsInflight: AccountModelRecordsInflight | null;
  watchdogRegistered: boolean;
  lastProviderSyncWarnings: string[];
};

const GLOBAL_KEY = "__leafcodePiHarness" as const;

/** Coalesce concurrent ensureLive(taskId) so only one Pi session is created. */
const ensureLiveInflight = new Map<string, Promise<LiveRuntime>>();
/** Bumped by disposeLive so inflight ensureLive abandons a disposed runtime. */
const ensureLiveEpoch = new Map<string, number>();
const promoteInflight = new Map<string, Promise<PromoteTaskResult>>();
const promoteDestinationInflight = new Map<string, Promise<void>>();

type PromoteTaskResult = {
  task: TaskSummary;
  project: ProjectDto;
  warning?: string;
};
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
    revertLeafId: live.revertLeafId,
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
      accountRecordsCache: null,
      accountRecordsInflight: null,
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
  const promise = Promise.all([
    registerCursorProvider(runtime, scope),
    registerCommandCodeProvider(runtime, scope),
    registerOllamaCloudProvider(runtime),
    registerRemoteProvider(runtime),
  ]).then(() => undefined);
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
      abortTask: abortLiveForHangWatchdog,
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
        persistHangRetryCount(taskId, retryCount);
        const live = current.live.get(taskId);
        if (!live) return;
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
    revertLeafId: live.revertLeafId,
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
  // ライフサイクルイベントの連続（message_start/end・agent_start 等）も100ms窓で
  // 1つのスナップショットへ合流させる。従来はイベント毎に全履歴の射影と数MBの
  // フルSSE送信が走り、送信直後の反映遅延の主因だった。
  if (THROTTLED_SNAPSHOT_EVENTS.has(eventType)) {
    // フルスナップショット待機中に来た delta は、そのフルに含まれるため送らない。
    if (live.pendingSnapshotEventType && !live.pendingSnapshotIsDelta) return;
  }
  live.pendingSnapshotEventType = eventType;
  live.pendingSnapshotExtra = extra;
  live.pendingSnapshotIsDelta = THROTTLED_SNAPSHOT_EVENTS.has(eventType);
  if (live.snapshotTimer) return;
  live.snapshotTimer = setTimeout(() => {
    live.snapshotTimer = null;
    const pendingType = live.pendingSnapshotEventType ?? eventType;
    const pendingExtra = live.pendingSnapshotExtra;
    const isDelta = live.pendingSnapshotIsDelta === true;
    live.pendingSnapshotEventType = null;
    live.pendingSnapshotExtra = undefined;
    live.pendingSnapshotIsDelta = false;
    if (isDelta) emitTaskDelta(live, pendingType);
    else emitTaskSnapshot(live, pendingType, pendingExtra);
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

function isActiveGoalLoopSession(session: AgentSession): boolean {
  try {
    const loop = readGoalLoopState(
      session.sessionManager.getCwd(),
      session.sessionId,
    );
    return Boolean(
      loop &&
        ["queued", "running", "verifying_completed"].includes(loop.status),
    );
  } catch {
    return false;
  }
}

function applySessionCompactionSettings(
  session: AgentSession,
  enabledOverride?: boolean,
  skipGoalLoop = false,
): void {
  const action = parseCompactionAction(
    getSetting(COMPACTION_ACTION_SETTING_KEY),
  );
  const threshold = parseCompactionThreshold(
    getSetting(COMPACTION_THRESHOLD_SETTING_KEY),
  );
  const goalLoopActive = skipGoalLoop || isActiveGoalLoopSession(session);
  const contextWindow = Number(session.model?.contextWindow ?? 0);
  const settingsManager = session.settingsManager;
  if (
    !settingsManager ||
    typeof settingsManager.applyOverrides !== "function"
  ) {
    return;
  }
  settingsManager.applyOverrides({
    compaction: {
      enabled: goalLoopActive ? false : (enabledOverride ?? action === "auto"),
      ...(contextWindow > 0 && !goalLoopActive
        ? { reserveTokens: reserveTokensForThreshold(contextWindow, threshold) }
        : {}),
    },
  });
}

function scheduleAutoCompaction(live: LiveRuntime): void {
  if (
    live.autoCompactionPromise ||
    live.manualCompactionInProgress ||
    live.manualAbortedAssistantId ||
    live.nativeCompactionAttempted ||
    live.goalLoopTurnActive ||
    live.session.isCompacting ||
    isActiveGoalLoopSession(live.session)
  ) {
    return;
  }
  const action = parseCompactionAction(
    getSetting(COMPACTION_ACTION_SETTING_KEY),
  );
  const threshold = parseCompactionThreshold(
    getSetting(COMPACTION_THRESHOLD_SETTING_KEY),
  );
  let percent: number | null | undefined;
  try {
    percent = live.session.getContextUsage()?.percent;
  } catch {
    percent = undefined;
  }
  if (!shouldCompactAtThreshold(action, percent, threshold)) return;

  const operation = Promise.resolve()
    .then(() => live.session.compact())
    .then(() => undefined)
    .catch((error) => {
      console.warn(
        `[leafcode-pi] automatic compaction failed for ${live.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      if (live.autoCompactionPromise === operation) {
        live.autoCompactionPromise = null;
      }
    });
  live.autoCompactionPromise = operation;
}

function openSettingsManager() {
  const pi = state().pi;
  if (!pi)
    throw Object.assign(new Error("Pi ランタイムが初期化されていません"), {
      status: 503,
    });
  return pi.SettingsManager.create(homedir(), pi.getAgentDir());
}

const providerFallbackInflight = new Map<string, Promise<void>>();

function lastAssistantLimitError(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "agent_end" || !Array.isArray(record.messages)) return null;
  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const message = record.messages[index];
    if (!message || typeof message !== "object") continue;
    const item = message as Record<string, unknown>;
    if (item.role !== "assistant") continue;
    const error =
      typeof item.errorMessage === "string"
        ? item.errorMessage
        : typeof item.error === "string"
          ? item.error
          : "";
    return error && isProviderLimitError(error) ? error : null;
  }
  return null;
}

function canAutoFallbackTask(task: TaskSummary, providerID: string): boolean {
  if (task.providerID !== providerID) return false;
  if (!task.accountId) return true;
  return (
    isAccountRoutingProvider(providerID) &&
    accountRoutingMode(providerID) === "integrated"
  );
}

async function fallbackProviderAfterLimit(
  live: LiveRuntime,
  pending: NonNullable<LiveRuntime["pendingProviderFallback"]>,
): Promise<void> {
  const existing = providerFallbackInflight.get(live.taskId);
  if (existing) return existing;
  const operation = (async () => {
    const task = getTask(live.taskId);
    if (
      !task ||
      !task.providerID ||
      !task.modelID ||
      task.providerID !== pending.providerID ||
      task.modelID !== pending.modelID ||
      !canAutoFallbackTask(task, pending.providerID)
    ) {
      return;
    }

    await withRouteLock(
      `${task.providerID}::${task.modelID}`,
      async () => {
        let currentLive = state().live.get(task.id) ?? live;
        const pendingCompaction = currentLive.autoCompactionPromise;
        if (pendingCompaction) {
          await pendingCompaction.catch(() => undefined);
          currentLive = state().live.get(task.id) ?? currentLive;
        }
        const latestTask = getTask(task.id);
        if (
          !latestTask ||
          !latestTask.providerID ||
          !latestTask.modelID ||
          latestTask.providerID !== pending.providerID ||
          latestTask.modelID !== pending.modelID ||
          currentLive.session.isStreaming
        ) {
          return;
        }
        const routes = await resolveProviderFallbackRoutes({
          providerID: pending.providerID,
          modelID: pending.modelID,
          ...(currentLive.accountId ? { accountId: currentLive.accountId } : {}),
        });
        const route = routes[0];
        if (!route) return;
        const ids = modelId(route.model);
        if (
          ids.providerID === latestTask.providerID &&
          ids.modelID === latestTask.modelID &&
          route.accountId === (latestTask.accountId ?? null)
        ) {
          return;
        }
        const nextLive = await replaceLiveForRoute(currentLive, latestTask, route);
        setTaskStatus(nextLive.taskId, "idle");
        emitTaskSnapshot(nextLive, "provider_fallback", {
          fallbackFrom: `${pending.providerID}::${pending.modelID}`,
        });
      },
    );
  })().finally(() => {
    if (providerFallbackInflight.get(live.taskId) === operation) {
      providerFallbackInflight.delete(live.taskId);
    }
  });
  providerFallbackInflight.set(live.taskId, operation);
  return operation;
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
    autoCompactionPromise: null,
    manualCompactionInProgress: false,
    nativeCompactionAttempted: false,
    goalLoopTurnActive: false,
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
    pendingSnapshotIsDelta: false,
    pendingSnapshotExtra: undefined,
    revertLeafId: existing?.revertLeafId ?? getTask(taskId)?.revertLeafId ?? null,
    manualAbortedAssistantId:
      existing?.manualAbortedAssistantId ??
      getTask(taskId)?.manualAbortedAssistantId ??
      null,
    hangRetryCount:
      existing?.hangRetryCount ?? getTask(taskId)?.hangRetryCount ?? 0,
    reasoningFallbackTried: false,
    pendingProviderFallback: existing?.pendingProviderFallback ?? null,
    restoreAutoRetry: false,
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      live.nativeCompactionAttempted = false;
      live.goalLoopTurnActive = isActiveGoalLoopSession(session);
      applySessionCompactionSettings(
        session,
        undefined,
        live.goalLoopTurnActive,
      );
    }
    if (event.type === "compaction_start" && event.reason !== "manual") {
      live.nativeCompactionAttempted = true;
    }
    if (event.type === "agent_end" && isActiveGoalLoopSession(session)) {
      live.goalLoopTurnActive = true;
    }
    const limitMessage = lastAssistantLimitError(event);
    const ids = modelId(session.model);
    if (event.type === "agent_end" && ids.providerID) {
      if (limitMessage) {
        markRouteLimited(ids.providerID, live.accountId);
        live.pendingProviderFallback = {
          providerID: ids.providerID,
          modelID: ids.modelID ?? "",
          message: limitMessage,
        };
        if (
          session.autoRetryEnabled &&
          typeof session.setAutoRetryEnabled === "function"
        ) {
          session.setAutoRetryEnabled(false);
          live.restoreAutoRetry = true;
        }
      } else if (!event.willRetry) {
        clearRouteLimit(ids.providerID, live.accountId);
      }
    }

    const harnessAutoCompactionError =
      event.type === "compaction_end" &&
      !event.aborted &&
      Boolean(event.errorMessage) &&
      live.autoCompactionPromise !== null;
    const syncTask =
      event.type === "agent_start" ||
      event.type === "agent_settled" ||
      (event.type === "agent_end" && !event.willRetry) ||
      (event.type === "compaction_end" &&
        !event.aborted &&
        Boolean(event.errorMessage) &&
        (event.reason !== "manual" || harnessAutoCompactionError));
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
    if (event.type === "agent_settled") {
      if (live.restoreAutoRetry) {
        session.setAutoRetryEnabled(true);
        live.restoreAutoRetry = false;
      }
      const goalLoopTurnActive = live.goalLoopTurnActive;
      live.goalLoopTurnActive = false;
      if (!goalLoopTurnActive) scheduleAutoCompaction(live);
      const pending = live.pendingProviderFallback;
      live.pendingProviderFallback = null;
      if (pending && pending.modelID) {
        void fallbackProviderAfterLimit(live, pending).catch((error) => {
          console.warn(
            `[leafcode-pi] provider fallback failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    }
    if (
      event.type === "compaction_end" &&
      !event.aborted &&
      event.errorMessage &&
      (event.reason !== "manual" || harnessAutoCompactionError)
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
      const pendingExtra = live.pendingSnapshotExtra;
      const isDelta = live.pendingSnapshotIsDelta === true;
      live.pendingSnapshotEventType = null;
      live.pendingSnapshotExtra = undefined;
      live.pendingSnapshotIsDelta = false;
      if (pendingType) {
        if (isDelta) emitTaskDelta(live, pendingType);
        else emitTaskSnapshot(live, pendingType, pendingExtra);
      }
    }
    unsubscribe();
  };
  current.live.set(taskId, live);
  return live;
}

/** live セッションを破棄し、保持していたアカウントランタイムの参照を解放する。 */
function disposeLive(taskId: string): void {
  ensureLiveEpoch.set(taskId, (ensureLiveEpoch.get(taskId) ?? 0) + 1);
  disarmTaskHangWatch(taskId);
  clearPendingAttentionForTask(taskId);
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
  /** Goal Loop sessions intentionally do not inherit WebUI compaction settings. */
  goalLoop?: boolean;
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
  // Bundled LeafCode extensions load straight from this repository's
  // extensions/ dir; stale same-name copies under ~/.pi are dropped so they
  // never register duplicate tools.
  const bundled = bundledExtensionEntries();
  const bundledNames = new Set(bundled.map((entry) => entry.name));
  const bundledPaths = new Set(bundled.map((entry) => entry.filePath));
  // Bundled forks replace their upstream npm extensions. Drop those stale
  // entries so their tools are never registered twice.
  const forkOwnsSubagents = bundledNames.has("leafcode-subagents");
  const forkOwnsMcpAdapter = bundledNames.has("leafcode-mcp-adapter");
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
    additionalExtensionPaths: bundled.map((entry) => entry.filePath),
    extensionFactories: [registerDeferredTools],
    skillsOverride: (base) => {
      if (agentOptions?.noSkills || skillPermissionRef.current === "deny") {
        return { skills: [], diagnostics: base.diagnostics };
      }
      return {
        skills: compactSkillsForPrompt(
          filterSkillsByState(base.skills).filter((skill) => !isAgentsSkill(skill)),
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
            !(forkOwnsMcpAdapter && basenameKey(extension.path) === "pi-mcp-adapter") &&
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
  const permissionMode =
    options.permissionMode ?? readPermissionGateConfig();
  const persistPermission = options.permissionMode !== undefined;
  // Agent-defined tool allowlist wins; otherwise default tools. Deferred tools
  // stay allowed so tool_search can activate them, then session_start removes
  // their schemas from the initial model request. `subagent` remains governed
  // independently by the user's delegation permission.
  const shellTools = process.platform === "win32" ? ["powershell", "bash"] : ["bash"];
  const configuredTools = agentOptions?.tools
    ? needsToolSearch(agentOptions.tools)
      ? [...new Set([...agentOptions.tools, TOOL_SEARCH_NAME])]
      : agentOptions.tools
    : [
        "read",
        "write",
        "edit",
        ...shellTools,
        "question",
        "grep",
        "find",
        "ls",
        "memory_search",
        "memory_add",
        "memory_replace",
        "memory_remove",
        "session_search",
        "skill_manage",
        ...(options.subagentPermission === "allow" ? ["subagent"] : []),
        "todowrite",
        TOOL_SEARCH_NAME,
      ];
  const tools = configuredTools;
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
  // Apply after bindExtensions() so an explicit mode wins over persisted state.
  applyPermissionMode(result.session, permissionMode, {
    persist: persistPermission,
  });
  // Agent-defined tools may include `subagent`; enforce the user choice after
  // the full extension registry is ready, including the initial turn.
  applySubagentPermission(result.session, options.subagentPermission);
  applySessionCompactionSettings(result.session, undefined, options.goalLoop === true);
  return { session: result.session, skillPermissionRef };
}

type ConcreteModelRoute = {
  accountId: string | null;
  runtime: ModelRuntime;
  model: Model;
};

export type ProviderFallbackModel = {
  providerID: string;
  modelID: string;
  accountId?: string;
};

function modelWithContextWindow(
  model: Model,
  providerID: string,
  modelID: string,
  accountId?: string | null,
): Model {
  const contextWindow = contextWindowForModel(providerID, modelID, readProviderModelState(), accountId);
  return contextWindow === undefined ? model : { ...model, contextWindow, maxTokens: Math.min(model.maxTokens, contextWindow) };
}

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

function usageForProvider(
  providerID: string,
  accountId?: string | null,
): CodexBarProvider | undefined {
  return getCachedUsage()?.providers.find(
    (provider) =>
      provider.id === providerID &&
      (provider.accountId ?? null) === (accountId ?? null),
  );
}

function markRouteLimited(
  providerID: string,
  accountId?: string | null,
): void {
  const usage = usageForProvider(providerID, accountId);
  markProviderLimited(
    providerID,
    accountId,
    usage?.maxed && !usage.stale ? usage.resetsAt : null,
  );
  invalidateHealthCache();
}

function clearRouteLimit(
  providerID: string,
  accountId?: string | null,
): void {
  if (!providerLimitMark(providerID, accountId)) return;
  clearProviderLimit(providerID, accountId);
  invalidateHealthCache();
}

function futureReset(resetAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!resetAt) return false;
  const parsed = Date.parse(resetAt);
  return Number.isFinite(parsed) && parsed > nowMs;
}

function providerIsHardLimited(
  providerID: string,
  accountId?: string | null,
): boolean {
  if (providerLimitMark(providerID, accountId)) return true;
  const usage = usageForProvider(providerID, accountId);
  return Boolean(
    usage?.maxed &&
      !usage.stale &&
      (!usage.resetsAt || futureReset(usage.resetsAt)),
  );
}

function providerResetAt(
  providerID: string,
  accountId?: string | null,
): string | null {
  return (
    providerLimitMark(providerID, accountId)?.resetAt ??
    (providerIsHardLimited(providerID, accountId)
      ? usageForProvider(providerID, accountId)?.resetsAt ?? null
      : null)
  );
}

function markedUsage(
  providerID: string,
  accountId: string,
  usage: CodexBarProvider | undefined,
): CodexBarProvider | null {
  const mark = providerLimitMark(providerID, accountId);
  if (!mark) return usage ?? null;
  return {
    ...(usage ?? {
      id: providerID,
      accountId,
      opencodeId: null,
      plan: null,
      planMonthlyUsd: null,
      limited: true,
      updatedAt: null,
      error: null,
      windows: [],
      credits: null,
    }),
    accountId,
    usedPercent: Math.max(usage?.usedPercent ?? 100, 100),
    maxed: true,
    stale: false,
    resetsAt: mark.resetAt ?? usage?.resetsAt ?? null,
  };
}

async function resolveIntegratedModelRoute(
  providerID: string,
  modelID: string,
  options?: { excludeAccountId?: string | null },
): Promise<ConcreteModelRoute | undefined> {
  const excluded = options?.excludeAccountId ?? null;
  const accounts = listAccounts().filter(
    (account) =>
      accountHasProvider(account, providerID) && account.id !== excluded,
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
      usage: markedUsage(
        providerID,
        record.accountId,
        usageProviders.find(
          (provider) =>
            provider.id === providerID &&
            provider.accountId === record.accountId,
        ),
      ),
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
        model: modelWithContextWindow(model, providerID, modelID, candidate.accountId),
      };
    }
  }
  return undefined;
}

function providerOrderRank(
  providerID: string,
  providerOrder: readonly string[],
  usageOrder: readonly string[],
): number {
  const scoped = providerOrder
    .map((key, index) => ({ key, index }))
    .filter(
      ({ key }) =>
        key === providerID ||
        key.split("::").length === 2 && key.endsWith(`::${providerID}`),
    )
    .map(({ index }) => index);
  if (scoped.length > 0) return Math.min(...scoped);
  const usageIndex = usageOrder.indexOf(providerID);
  return usageIndex < 0
    ? providerOrder.length + usageOrder.length + 1_000_000
    : providerOrder.length + usageIndex;
}

function routeModelRef(route: ConcreteModelRoute): ProviderFallbackModel | null {
  const ids = modelId(route.model);
  if (!ids.providerID || !ids.modelID) return null;
  return {
    providerID: ids.providerID,
    modelID: ids.modelID,
    ...(route.accountId ? { accountId: route.accountId } : {}),
  };
}

async function resolveProviderFallbackRoutes(
  source: ProviderFallbackModel,
): Promise<ConcreteModelRoute[]> {
  const modelIdsByProvider = new Map<string, string[]>();
  const addModel = (providerID: string, modelID: string) => {
    if (!providerID || !modelID) return;
    const modelIds = modelIdsByProvider.get(providerID) ?? [];
    if (!modelIds.includes(modelID)) modelIds.push(modelID);
    modelIdsByProvider.set(providerID, modelIds);
  };
  try {
    for (const record of await collectAccountModelRecords(listAccounts())) {
      addModel(record.option.providerID, record.option.modelID);
    }
  } catch {
    // アカウントのモデル収集失敗は、共有候補だけに切り替える。
  }
  try {
    for (const option of await listModels()) {
      addModel(option.providerID, option.modelID);
    }
  } catch {
    // 共有カタログが未取得でもアカウント候補で続行する。
  }
  if (modelIdsByProvider.size === 0) return [];

  const providerOrder = readProviderModelState().providerOrder;
  const usageOrder = getCachedUsage()?.providerOrder ?? [];
  const providerIds = [...modelIdsByProvider.keys()].sort(
    (a, b) =>
      providerOrderRank(a, providerOrder, usageOrder) -
        providerOrderRank(b, providerOrder, usageOrder) ||
      a.localeCompare(b, "en"),
  );
  const routes: ConcreteModelRoute[] = [];

  // A limited concrete account should first give another account in the same
  // integrated provider a chance; only then do we cross the provider boundary.
  if (
    source.accountId &&
    isAccountRoutingProvider(source.providerID)
  ) {
    try {
      const route = await resolveIntegratedModelRoute(
        source.providerID,
        source.modelID,
        { excludeAccountId: source.accountId },
      );
      if (route) routes.push(route);
    } catch {
      // Continue to the next provider when every account in this provider is limited.
    }
  }

  for (const providerID of providerIds) {
    if (providerID === source.providerID) continue;
    const modelIds = modelIdsByProvider.get(providerID) ?? [];
    const orderedModelIds = [
      ...(modelIds.includes(source.modelID) ? [source.modelID] : []),
      ...modelIds.filter((modelID) => modelID !== source.modelID),
    ];
    for (const modelID of orderedModelIds) {
      try {
        const route = isAccountRoutingProvider(providerID)
          ? await resolveIntegratedModelRoute(providerID, modelID)
          : await resolveConcreteModel(
              modelValue(providerID, modelID),
              null,
              { strictAccountId: false },
            );
        if (route) {
          routes.push(route);
          break;
        }
      } catch {
        // A limited or unavailable model must not block lower-priority providers.
      }
    }
  }
  return routes;
}

/** Resolve concrete fallbacks in provider priority order for direct generation. */
export async function resolveProviderFallbackModels(
  source: ProviderFallbackModel,
): Promise<ProviderFallbackModel[]> {
  return (await resolveProviderFallbackRoutes(source))
    .map(routeModelRef)
    .filter((model): model is ProviderFallbackModel => model !== null);
}

async function resolveConcreteModel(
  value: string | undefined,
  requestedAccountId?: string | null,
  options?: { strictAccountId?: boolean; accountIdExplicit?: boolean },
): Promise<ConcreteModelRoute | undefined> {
  await ensureRuntime();
  const parsed = parseModelValue(value);
  if (!parsed) return undefined;

  const explicitAccountId = parsed.accountId;
  const accountIdExplicit =
    options?.accountIdExplicit ?? Boolean(explicitAccountId);
  const requested = requestedAccountId?.trim() || explicitAccountId;
  const strictAccountId = options?.strictAccountId ?? accountIdExplicit;
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
        ? { accountId: requested, runtime: record.runtime, model: modelWithContextWindow(model, parsed.providerID, parsed.modelID, requested) }
        : undefined;
    }
  }

  if (
    !accountIdExplicit &&
    isAccountRoutingProvider(parsed.providerID) &&
    runsThroughAccounts(parsed.providerID) &&
    listAccounts().some((account) => accountHasProvider(account, parsed.providerID))
  ) {
    return resolveIntegratedModelRoute(parsed.providerID, parsed.modelID);
  }

  // Shared providers never use an account runtime, even when a caller carries
  // a task account for a different provider.
  if (providerIsHardLimited(parsed.providerID)) {
    throw routeLimitError(providerResetAt(parsed.providerID));
  }
  const runtime = await getRuntimeFor();
  if (!runtime) return undefined;
  const model = runtime.getModel(parsed.providerID, parsed.modelID);
  return model
    ? { accountId: null, runtime, model: modelWithContextWindow(model, parsed.providerID, parsed.modelID) }
    : undefined;
}

async function resolveConcreteModelWithFallback(
  value: string | undefined,
  requestedAccountId?: string | null,
  options?: {
    strictAccountId?: boolean;
    allowProviderFallback?: boolean;
    accountIdExplicit?: boolean;
  },
): Promise<ConcreteModelRoute | undefined> {
  const parsed = parseModelValue(value);
  if (!parsed) return undefined;
  const explicit = options?.accountIdExplicit ?? Boolean(parsed.accountId);
  let sourceError: unknown;
  let route: ConcreteModelRoute | undefined;
  try {
    route = await resolveConcreteModel(value, requestedAccountId, {
      strictAccountId: options?.strictAccountId,
      accountIdExplicit: explicit,
    });
    if (
      route &&
      requestedAccountId &&
      !explicit &&
      isAccountRoutingProvider(parsed.providerID) &&
      providerIsHardLimited(parsed.providerID, requestedAccountId)
    ) {
      sourceError = routeLimitError(
        providerResetAt(parsed.providerID, requestedAccountId),
      );
      route = undefined;
    }
  } catch (error) {
    sourceError = error;
  }
  if (route) return route;
  if (
    options?.allowProviderFallback === false ||
    explicit ||
    !sourceError ||
    !isProviderLimitError(sourceError)
  ) {
    if (sourceError) throw sourceError;
    return undefined;
  }

  const fallbackRoutes = await resolveProviderFallbackRoutes({
    providerID: parsed.providerID,
    modelID: parsed.modelID,
    ...(requestedAccountId ? { accountId: requestedAccountId } : {}),
  });
  if (fallbackRoutes[0]) return fallbackRoutes[0];
  if (sourceError) throw sourceError;
  return undefined;
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
  const limitError =
    task.status === "error" && isProviderLimitError(task.error)
      ? { limitError: true }
      : {};
  const live = state().live.get(task.id);
  if (!live) return { ...task, ...limitError };
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
    ...limitError,
    ...(todoProgress ? { todoProgress } : {}),
    ...(goalLoopSummary ? { goalLoopSummary } : {}),
  };
}

async function ensureLive(
  taskId: string,
  options?: { allowDuringPromotion?: boolean },
): Promise<LiveRuntime> {
  if (!options?.allowDuringPromotion) {
    const promotion = promoteInflight.get(taskId);
    if (promotion) await promotion.catch(() => undefined);
  }
  const current = state();
  const existing = current.live.get(taskId);
  if (existing) return existing;

  const epoch = ensureLiveEpoch.get(taskId) ?? 0;
  const inflight = ensureLiveInflight.get(taskId);
  if (inflight) {
    await inflight;
    if ((ensureLiveEpoch.get(taskId) ?? 0) !== epoch) {
      return ensureLive(taskId, options);
    }
    const stillLive = state().live.get(taskId);
    if (stillLive) return stillLive;
    return ensureLive(taskId, options);
  }

  const promise = (async () => {
    const again = state().live.get(taskId);
    if (again) return again;

    const task = getTask(taskId);
    if (!task)
      throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
    const project = task.projectId ? getProject(task.projectId) : undefined;
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
      permissionMode: task.permissionMode,
      agentName: task.agent ?? null,
    });
    if ((ensureLiveEpoch.get(taskId) ?? 0) !== epoch) {
      try {
        setup.session.dispose();
      } catch {
        /* best-effort */
      }
      return ensureLive(taskId, options);
    }
    patchTask(taskId, {
      sessionId: setup.session.sessionId,
      sessionFile: setup.session.sessionFile,
      ...modelId(setup.session.model),
    });
    const attached = await attachSession(
      taskId,
      setup.session,
      setup.skillPermissionRef,
    );
    if ((ensureLiveEpoch.get(taskId) ?? 0) !== epoch) {
      if (state().live.get(taskId) === attached) {
        disposeLive(taskId);
      }
      return ensureLive(taskId, options);
    }
    return attached;
  })().finally(() => {
    if (ensureLiveInflight.get(taskId) === promise) {
      ensureLiveInflight.delete(taskId);
    }
  });

  ensureLiveInflight.set(taskId, promise);
  return promise;
}

async function withPromotionDestinationLock<T>(
  destination: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = pathKey(destination);
  const previous = promoteDestinationInflight.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  promoteDestinationInflight.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (promoteDestinationInflight.get(key) === current) {
      promoteDestinationInflight.delete(key);
    }
  }
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
  const warnings = (
    await Promise.all([
      syncLlamaServerProvider(runtime).then(() => null).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[leafcode-pi] llama-server provider sync failed:", message);
        return `llama-server: ${message}`;
      }),
      syncOllamaCloudProvider(runtime).then(() => null).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[leafcode-pi] ollama-cloud provider sync failed:", message);
        return `ollama-cloud: ${message}`;
      }),
      syncRemoteProvider(runtime).then(() => null).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[leafcode-pi] leafcodecloud provider sync failed:", message);
        return `leafcodecloud: ${message}`;
      }),
    ])
  ).filter((warning): warning is string => warning !== null);
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
type AccountModelRecordCacheEntry = {
  at: number;
  key: string;
  value: AccountModelRecord[];
};
type AccountModelRecordsInflight = { key: string; promise: Promise<AccountModelRecord[]> };

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
  current.accountRecordsCache = null;
  current.accountRecordsInflight = null;
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
  const accountSnapshot =
    current.accountModelCache?.key === accountModelsKey(accounts)
      ? current.accountModelCache.value
      : null;
  const sharedModels = accountSnapshot
    ? []
    : (await getRuntimeFor())
      ? (await listModels().catch(() => [])).filter(
          (model) => !runsThroughAccounts(model.providerID),
        )
      : [];
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
function providerModelSnapshot(
  runtime: ModelRuntime,
  providerIds?: readonly string[],
): { refs: ProviderModelRef[]; models: ProviderModelSnapshot } {
  const allowed = providerIds ? new Set(providerIds) : undefined;
  const refs: ProviderModelRef[] = [];
  const models = new Map<string, readonly { id: string; name?: string; provider?: string }[]>();
  for (const provider of runtime.getProviders()) {
    if (!runtime.hasConfiguredAuth(provider.id)) continue;
    const providerModels = runtime.getModels(provider.id);
    models.set(provider.id, providerModels);
    if (allowed !== undefined && !allowed.has(provider.id)) continue;
    for (const model of providerModels) {
      refs.push({ providerID: provider.id, modelID: model.id });
    }
  }
  return { refs, models };
}

async function buildModelOptions(
  runtime: ModelRuntime,
  accountId?: string,
  providerIds?: readonly string[],
): Promise<ModelOption[]> {
  if (!accountId) await syncProvidersBestEffort(runtime);
  const snapshot = providerModelSnapshot(runtime, providerIds);
  const state = await ensureProviderModelsKnown(snapshot.refs, accountId);
  const catalog = buildProviderModelsCatalog(
    runtime,
    state,
    accountId,
    snapshot.models,
  );
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
  const current = state();
  const key = accountModelsKey(accounts);
  const cached = current.accountRecordsCache;
  if (cached?.key === key) {
    const age = Date.now() - cached.at;
    if (age >= 0 && age < MODEL_TTL_MS) {
      const value = cached.value;
      // キャッシュ済みランタイムは解放済みの可能性があるため取り直す（ensure は実質Map参照）。
      const refreshed = await Promise.all(
        value.map(async (record) => {
          try {
            const runtime = await getRuntimeFor(record.accountId);
            return runtime ? { ...record, runtime } : null;
          } catch {
            return null;
          }
        }),
      );
      return refreshed.filter(
        (record): record is AccountModelRecord => record !== null,
      );
    }
  }
  if (current.accountRecordsInflight?.key === key) {
    return current.accountRecordsInflight.promise;
  }

  const promise = (async () => {
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
  })();
  current.accountRecordsInflight = { key, promise };
  try {
    const value = await promise;
    if (current.accountRecordsInflight?.promise === promise) {
      current.accountRecordsCache = { key, at: Date.now(), value };
      current.healthCache = null;
    }
    return value;
  } finally {
    if (current.accountRecordsInflight?.promise === promise) {
      current.accountRecordsInflight = null;
    }
  }
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

/** リミット応答で除外中の候補は、モデル一覧・Auto の候補選択でも上限扱いにする。 */
function applyLimitMark(option: ModelOption): ModelOption {
  if (!providerLimitMark(option.providerID, option.accountId)) return option;
  return {
    ...option,
    codexbarUsedPercent: 100,
    codexbarMaxed: true,
    codexbarStale: false,
  };
}

function applyRoutingUsage(
  option: ModelOption,
  usageProviders: readonly CodexBarProvider[],
): ModelOption {
  const marked = applyLimitMark(option);
  if (marked.codexbarMaxed === true && marked.codexbarStale !== true) {
    return marked;
  }
  const usage = usageProviders.find(
    (provider) =>
      provider.id === option.providerID &&
      (provider.accountId ?? null) === (option.accountId ?? null),
  );
  if (!usage) return marked;
  return {
    ...marked,
    codexbarUsedPercent: usage.usedPercent,
    codexbarMaxed: usage.maxed,
    ...(usage.stale ? { codexbarStale: true } : {}),
  };
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
      usage: markedUsage(
        providerID,
        record.accountId,
        usageProviders.find(
          (provider) =>
            provider.id === providerID &&
            provider.accountId === record.accountId,
        ),
      ),
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
    codexbarUsedPercent:
      decision.allMaxed
        ? 100
        : selectedUsage?.usedPercent ?? null,
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
  usageTtlMs = 30 * 60 * 1000,
): Promise<ModelOption[]> {
  const usageProviders =
    getCachedUsage(Date.now(), usageTtlMs)?.providers ?? [];
  const [sharedOptions, records] = await Promise.all([
    listModels()
      .catch(() => [])
      .then((options) =>
        options
          .filter((option) => !runsThroughAccounts(option.providerID))
          .map((option) => applyRoutingUsage(option, usageProviders)),
      ),
    collectAccountModelRecords(accounts),
  ]);
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
      separate.push(
        applyRoutingUsage(
          {
            ...record.option,
            value: `${record.accountId}::${record.option.value}`,
            accountId: record.accountId,
            accountLabel: record.accountLabel,
          },
          usageProviders,
        ),
      );
    }
  }

  // The picker may display the same 30-minute last-good window as /api/models;
  // resolveAutoModel deliberately supplies the strict 5-minute TTL.
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

export async function resolveAutoModel(input: {
  prompt: string;
  hasImages: boolean;
  attachmentCount?: number;
  historyMessageCount?: number;
  recentFailure?: boolean;
  mode: AutoOptimizeMode;
  config?: AutoRouteConfig;
}): Promise<AutoDecision | null> {
  const accounts = listAccounts().map((account) => ({
    id: account.id,
    label: account.label,
    providers: account.providers,
  }));
  const models = await buildModelsForAccounts(accounts, 5 * 60 * 1000);
  return chooseAutoModel({
    models,
    tier: classifyPrompt(input.prompt, {
      hasImages: input.hasImages,
      attachmentCount: input.attachmentCount ?? 0,
      historyMessageCount: input.historyMessageCount ?? 0,
      recentFailure: input.recentFailure === true,
    }),
    hasImages: input.hasImages,
    mode: input.mode,
    usage: autoProviderUsageFromModels(models),
    config: input.config,
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

  const sourceRoute = await resolveConcreteModelWithFallback(
    `${options.providerID}::${options.modelID}`,
    options.accountId ?? null,
    {
      strictAccountId: options.accountIdExplicit === true,
      accountIdExplicit: options.accountIdExplicit === true,
      allowProviderFallback: true,
    },
  );
  if (!sourceRoute)
    throw new Error(
      `モデルが見つかりません: ${options.providerID}::${options.modelID}`,
    );

  const sourceRef = routeModelRef(sourceRoute);
  const attempted = new Set<string>();
  let route: ConcreteModelRoute | undefined = sourceRoute;
  let lastError: unknown;
  while (route) {
    const routeRef = routeModelRef(route);
    const routeKey = routeRef
      ? `${routeRef.accountId ?? ""}::${routeRef.providerID}::${routeRef.modelID}`
      : "";
    if (!routeRef || attempted.has(routeKey)) break;
    attempted.add(routeKey);
    try {
      return await completeModelTextOnRoute(route, options, system, prompt);
    } catch (error) {
      lastError = error;
      if (!isProviderLimitError(error) || options.accountIdExplicit === true) {
        throw error;
      }
      markRouteLimited(routeRef.providerID, routeRef.accountId ?? null);
      const fallbacks = sourceRef
        ? await resolveProviderFallbackRoutes(sourceRef)
        : [];
      route = fallbacks.find((candidate) => {
        const candidateRef = routeModelRef(candidate);
        return (
          candidateRef !== null &&
          !attempted.has(
            `${candidateRef.accountId ?? ""}::${candidateRef.providerID}::${candidateRef.modelID}`,
          )
        );
      });
    }
  }
  throw lastError ?? new Error("利用可能なフォールバックモデルがありません");
}

async function completeModelTextOnRoute(
  route: ConcreteModelRoute,
  options: {
    maxTokens?: number;
    temperature?: number;
    reasoning?: Exclude<ThinkingLevel, "off">;
    signal?: AbortSignal;
  },
  system: string,
  prompt: string,
): Promise<string> {
  const ids = modelId(route.model);
  const providerID = ids.providerID ?? "";
  const modelID = ids.modelID ?? "";
  const heldAccountId = route.accountId;
  const manager = heldAccountId ? accountRuntimeManager() : null;
  const runtime = manager
    ? await manager.acquire(heldAccountId!)
    : route.runtime;
  try {
    const model = manager
      ? runtime.getModel(providerID, modelID)
      : route.model;
    if (!model)
      throw new Error(
        `モデルが見つかりません: ${providerID}::${modelID}`,
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
        // Codex rejects temperature regardless of the model catalog API label.
        ...(model.provider === "openai-codex" || model.api === "openai-codex-responses"
          ? {}
          : { temperature: Math.min(2, Math.max(0, options.temperature ?? 0.2)) }),
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

let providerModelsCatalogInflight: Promise<ProviderModelsRow[]> | null = null;

export function listProviderModelsCatalog(): Promise<ProviderModelsRow[]> {
  if (providerModelsCatalogInflight) return providerModelsCatalogInflight;
  const promise = listProviderModelsCatalogUncached();
  providerModelsCatalogInflight = promise;
  return promise.finally(() => {
    if (providerModelsCatalogInflight === promise) {
      providerModelsCatalogInflight = null;
    }
  });
}

async function listProviderModelsCatalogUncached(): Promise<ProviderModelsRow[]> {
  await ensureRuntime();
  let state = readProviderModelState();
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
    const snapshot = providerModelSnapshot(runtime);
    state = await ensureProviderModelsKnown(snapshot.refs);
    rows.push(
      ...buildProviderModelsCatalog(runtime, state, undefined, snapshot.models).filter(
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
          const snapshot = providerModelSnapshot(accountRuntime, providerIds);
          const accountState = await ensureProviderModelsKnown(
            snapshot.refs,
            account.id,
          );
          const catalog = buildProviderModelsCatalog(
            accountRuntime,
            accountState,
            account.id,
            snapshot.models,
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
    state = readProviderModelState();
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
      ...(isEditableBaseUrlProvider(provider.id)
        ? { baseUrl: effectiveBaseUrl(provider.id) }
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

/**
 * 変更可能なプロバイダーの API URL（base URL）を返す。
 * 保存値がなければ既定値、変更不可プロバイダーは空文字。
 * 変更は次回サーバー起動から反映されます。
 */
export function getProviderBaseUrl(providerId: string): string {
  return effectiveBaseUrl(providerId);
}

/** 変更可能なプロバイダーの API URL（base URL）を保存。次回起動から反映。 */
export function setProviderBaseUrl(
  providerId: string,
  baseUrl: string,
): void {
  setProviderBaseUrlFromEndpoints(providerId, baseUrl);
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
  if (
    mode === "integrated" &&
    listAccounts().filter((account) => accountHasProvider(account, providerId))
      .length < 2
  ) {
    throw Object.assign(
      new Error("アカウント統合には2つ以上のアカウントが必要です"),
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

async function promoteTaskOnce(
  taskId: string,
  destinationPath: string,
): Promise<PromoteTaskResult> {
  const task = getTask(taskId);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  if (task.projectId !== null)
    throw Object.assign(new Error("プロジェクトなしタスクのみ昇進できます"), {
      status: 409,
    });

  const live = state().live.get(taskId);
  const goalLoop = readGoalLoopState(task.directory, task.sessionId);
  if (
    task.status === "working" ||
    live?.session.isStreaming ||
    live?.session.isCompacting ||
    live?.promptActive ||
    ["queued", "running", "verifying_completed"].includes(goalLoop?.status ?? "")
  ) {
    throw Object.assign(new Error("実行中のタスクは停止してから昇進してください"), {
      status: 409,
    });
  }

  const source = resolve(task.directory);
  const noProjectBase = resolve(noProjectRoot());
  if (
    samePath(source, noProjectBase) ||
    !sameOrDescendantPath(source, noProjectBase)
  ) {
    throw Object.assign(new Error("無プロジェクトの作業フォルダーが不正です"), {
      status: 400,
    });
  }
  const rawDestination = destinationPath.trim();
  if (!isAbsolutePath(rawDestination))
    throw Object.assign(new Error("移動先には絶対パスを指定してください"), {
      status: 400,
    });
  const destination = resolve(rawDestination);
  if (sameOrDescendantPath(destination, source) || sameOrDescendantPath(source, destination)) {
    throw Object.assign(new Error("移動元と移動先を入れ子にはできません"), {
      status: 400,
    });
  }
  if (
    listProjects(true).some((project) => samePath(project.rootPath, destination))
  ) {
    throw Object.assign(new Error("移動先は既にプロジェクトとして登録されています"), {
      status: 409,
    });
  }
  const sessionFile = task.sessionFile;
  if (!sessionFile || !existsSync(sessionFile)) {
    throw Object.assign(new Error("保存済みセッションのあるタスクのみ昇進できます"), {
      status: 409,
    });
  }

  return withPromotionDestinationLock(destination, async () => {
    const hadSubscriber = state().events.listenerCount(taskId) > 0;
    disposeLive(taskId);
    let prepared: PreparedWorkspaceMove | undefined;
    let forkedSessionFile: string | undefined;
    let project: ProjectDto | undefined;
    let committed = false;
    try {
      prepared = await prepareWorkspaceMove(source, destination);
      const pi = await loadPi();
      if (
        listProjects(true).some((candidate) => samePath(candidate.rootPath, destination))
      ) {
        throw Object.assign(new Error("移動先は既にプロジェクトとして登録されています"), {
          status: 409,
        });
      }
      const forked = pi.SessionManager.forkFrom(sessionFile, destination);
      const nextSessionFile = forked.getSessionFile();
      if (!nextSessionFile) throw new Error("新しいセッションを作成できませんでした");
      if (sameOrDescendantPath(nextSessionFile, source)) {
        throw new Error("新しいセッションの保存先が不正です");
      }
      forkedSessionFile = nextSessionFile;

      project = addProject(destination);
      const updated = patchTask(taskId, {
        projectId: project.id,
        projectName: project.name,
        directory: destination,
        sessionId: forked.getSessionId(),
        sessionFile: forkedSessionFile,
      });
      if (!updated) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
      committed = true;

      const warnings: string[] = [];
      try {
        await prepared.finalize();
      } catch {
        warnings.push("元の作業フォルダーを削除できませんでした");
      }
      if (hadSubscriber) {
        try {
          const refreshed = await ensureLive(taskId, { allowDuringPromotion: true });
          emitTaskSnapshot(refreshed, "project_promoted");
        } catch {
          warnings.push("セッションの再接続は次回タスク表示時に行います");
        }
      }
      const resultTask = getTask(taskId) ?? updated;
      return {
        task: toSummary(resultTask),
        project,
        ...(warnings.length > 0 ? { warning: warnings.join("。") } : {}),
      };
    } catch (error) {
      if (!committed) {
        if (forkedSessionFile) {
          await rm(forkedSessionFile, { force: true }).catch(() => undefined);
        }
        if (project) deleteProjectRecord(project.id);
        if (prepared) await prepared.rollback().catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function promoteTask(
  taskId: string,
  destinationPath: string,
): Promise<PromoteTaskResult> {
  const existing = promoteInflight.get(taskId);
  if (existing) return existing;
  const operation = promoteTaskOnce(taskId, destinationPath).finally(() => {
    if (promoteInflight.get(taskId) === operation) promoteInflight.delete(taskId);
  });
  promoteInflight.set(taskId, operation);
  return operation;
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
  let hangRetryCount = 0;
  let revertLeafId: string | null = task.revertLeafId ?? null;
  let manualAbortedAssistantId: string | null = task.manualAbortedAssistantId ?? null;
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
    manualAbortedAssistantId = live.manualAbortedAssistantId ?? manualAbortedAssistantId;
    hangRetryCount = live.hangRetryCount || task.hangRetryCount || 0;
    revertLeafId = live.revertLeafId ?? revertLeafId;
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
    manualAbortedAssistantId,
    hangRetryCount,
    revertLeafId,
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

/** Validate a browser-selected model before any prompt is sent to a generation model. */
export async function validateTaskModelSelection(
  value: string,
  requestedAccountId?: string | null,
  options?: { accountIdExplicit?: boolean },
): Promise<void> {
  const parsed = parseModelValue(value);
  if (!parsed) {
    throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  }
  const requested = requestedAccountId?.trim() || parsed.accountId;
  if (requestedAccountId && parsed.accountId && requestedAccountId !== parsed.accountId) {
    throw Object.assign(new Error("モデルとアカウントの指定が一致しません"), {
      status: 400,
    });
  }
  if (requested && !getAccount(requested)) {
    throw Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
  }
  if (requested && !isAccountRoutingProvider(parsed.providerID)) {
    throw Object.assign(
      new Error("共有プロバイダーにはアカウントを指定できません"),
      { status: 400 },
    );
  }
  const accountIdExplicit =
    options?.accountIdExplicit ?? Boolean(requested);
  const route = await withRouteLock(
    `${parsed.providerID}::${parsed.modelID}`,
    () =>
      resolveConcreteModelWithFallback(value, requested ?? null, {
        strictAccountId: accountIdExplicit,
        accountIdExplicit,
        allowProviderFallback: true,
      }),
  );
  if (!route) {
    throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  }
}

export async function createTask(input: {
  projectId: string | null;
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
  accountIdExplicit?: boolean;
  goalLoop?: {
    acceptance?: string[];
    maxTurns?: number;
    cooldownSeconds?: number;
    forceFullRun?: boolean;
  };
}): Promise<TaskSummary> {
  const project = input.projectId ? getProject(input.projectId) ?? null : null;
  if (input.projectId && !project)
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
      ...(input.permissionMode
        ? { permissionMode: input.permissionMode }
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
        const route = await resolveConcreteModelWithFallback(
          input.model,
          requestedAccountId ?? null,
          {
            strictAccountId:
              input.accountIdExplicit ?? Boolean(requestedAccountId),
            accountIdExplicit:
              input.accountIdExplicit ?? Boolean(requestedAccountId),
            allowProviderFallback: true,
          },
        );
        if (!route)
          throw Object.assign(new Error("モデルが見つかりません"), {
            status: 400,
          });
        const routeIds = modelId(route.model);
        if (
          route.accountId &&
          routeIds.providerID &&
          isAccountRoutingProvider(routeIds.providerID)
        ) {
          reserveRoute(routeIds.providerID, route.accountId);
        }
        try {
          if (project) patchProject(project.id, { lastOpenedAt: new Date().toISOString() });
          return {
            route,
            task: insertStoredTask(route.model, route.accountId),
          };
        } catch (error) {
          if (
            route.accountId &&
            routeIds.providerID &&
            isAccountRoutingProvider(routeIds.providerID)
          ) {
            releaseRoute(routeIds.providerID, route.accountId);
          }
          throw error;
        }
      },
    );
    modelRoute = routed.route;
    concreteAccountId = routed.route.accountId;
    const routeIds = modelId(modelRoute.model);
    if (
      modelRoute.accountId &&
      routeIds.providerID &&
      isAccountRoutingProvider(routeIds.providerID)
    ) {
      reservedAccount = {
        providerID: routeIds.providerID,
        accountId: modelRoute.accountId,
      };
    }
    task = routed.task;
  } else {
    if (project) patchProject(project.id, { lastOpenedAt: new Date().toISOString() });
    task = insertStoredTask(undefined, concreteAccountId);
  }
  const model = modelRoute?.model;
  const requestedThinking = isThinkingLevel(input.thinkingLevel)
    ? input.thinkingLevel
    : "off";
  // The provider adapter performs the final model-specific clamping when it
  // builds the request. Do not clamp from the session-creation model metadata.
  const thinkingLevel = requestedThinking;
  try {
    const setup = await createSession({
      cwd: project?.rootPath ?? task.directory,
      sessionName: task.title,
      accountId: concreteAccountId,
      model,
      thinkingLevel,
      subagentPermission: input.subagentPermission,
      permissionMode: input.permissionMode,
      skillPermission: input.skillPermission,
      // The selected agent talks as the main persona for this whole session.
      agentName: input.agent ?? null,
      goalLoop: Boolean(input.goalLoop),
    });
    // createAgentSession may normalize the level from its model metadata. Keep
    // the user's Auto effort in the session; the provider clamps at request time.
    if (setup.session.thinkingLevel !== thinkingLevel) {
      setup.session.setThinkingLevel(thinkingLevel);
    }
    patchTask(task.id, {
      sessionId: setup.session.sessionId,
      sessionFile: setup.session.sessionFile,
      status: "working",
      thinkingLevel,
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
  const project = task.projectId ? getProject(task.projectId) : undefined;
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
    permissionMode: task.permissionMode,
    agentName: task.agent ?? null,
  });

  const routeIds = modelId(route.model);
  const updatedTask = patchTask(task.id, {
    accountId: route.accountId ?? undefined,
    providerID: routeIds.providerID ?? task.providerID,
    modelID: routeIds.modelID ?? task.modelID,
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

/** Select a fresh account/provider before a queued/next user turn. */
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
      !currentLive.session.isStreaming &&
      currentLive.session.messages.some((message) => message.role === "user") &&
      (isAccountRoutingProvider(task.providerID) &&
        accountRoutingMode(task.providerID) === "integrated"),
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

      // 通常は既存の統合アカウント再選択だけを行い、全アカウント上限（429）時だけ
      // 別プロバイダーへフォールバックする。
      let route: ConcreteModelRoute;
      try {
        const resolved = await resolveIntegratedModelRoute(
          latestTask.providerID,
          latestTask.modelID,
        );
        if (!resolved) {
          throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
        }
        route = resolved;
      } catch (error) {
        if (!isProviderLimitError(error)) throw error;
        const fallbackRoute = (
          await resolveProviderFallbackRoutes({
            providerID: latestTask.providerID,
            modelID: latestTask.modelID,
            ...(latestTask.accountId
              ? { accountId: latestTask.accountId }
              : {}),
          })
        )[0];
        if (!fallbackRoute) throw error;
        route = fallbackRoute;
      }
      const ids = modelId(route.model);
      const sameRoute =
        ids.providerID === latestTask.providerID &&
        ids.modelID === latestTask.modelID &&
        route.accountId === (latestTask.accountId ?? null);
      const nextLive = sameRoute
        ? latestLive
        : await replaceLiveForRoute(latestLive, latestTask, route);
      setTaskStatus(latestTask.id, "working");
      if (nextLive !== latestLive) {
        emitTaskSnapshot(nextLive, "provider_routed");
      }
      return nextLive;
    },
  );
}

export function buildPromptOptions({
  images,
  streamingBehavior,
  isStreaming,
  isHangRetry,
}: {
  images?: PromptImage[];
  streamingBehavior?: "steer" | "followUp";
  isStreaming: boolean;
  isHangRetry: boolean;
}): SessionPromptOptions {
  const options: SessionPromptOptions = {};
  if (isHangRetry) options.source = "extension";
  if (images?.length) {
    options.images = images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    }));
  }
  if (streamingBehavior) options.streamingBehavior = streamingBehavior;
  else if (isStreaming) options.streamingBehavior = "followUp";
  return options;
}

/** Only inject steer/follow-up into a turn that is already streaming. */
export function shouldBypassPromptChain(
  streamingBehavior: "steer" | "followUp" | undefined,
  isStreaming: boolean,
): boolean {
  return Boolean(streamingBehavior && isStreaming);
}

/**
 * Drop steer/follow-up once the current turn is no longer streaming so a
 * queued interrupt becomes a normal next prompt instead of a parallel run.
 */
export function resolveStreamingBehaviorForPrompt(
  streamingBehavior: "steer" | "followUp" | undefined,
  isStreaming: boolean,
): "steer" | "followUp" | undefined {
  return isStreaming ? streamingBehavior : undefined;
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
  persistManualAbortedAssistantId(live.taskId, null);
  if (!isHangRetry && !meta?.streamingBehavior) {
    persistHangRetryCount(live.taskId, 0);
  }
  const armHangWatchForPrompt = () => {
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
  };
  // Steer/follow-up must not replace the hang-watch resume prompt. Re-arming
  // with the short steer text would resume the wrong turn after a hang.
  if (!meta?.streamingBehavior) {
    armHangWatchForPrompt();
  }
  let activeLive = live;
  const runPrompt = async () => {
    const pendingCompaction = live.autoCompactionPromise;
    if (pendingCompaction) await pendingCompaction;
    const currentLive = state().live.get(live.taskId) ?? live;
    const streamingBehavior = resolveStreamingBehaviorForPrompt(
      meta?.streamingBehavior,
      currentLive.session.isStreaming,
    );
    activeLive = await prepareLiveForPrompt(live, !streamingBehavior);
    const activeCompaction = activeLive.autoCompactionPromise;
    if (activeCompaction) await activeCompaction;
    applySubagentPermission(activeLive.session, meta?.subagentPermission);
    applySessionCompactionSettings(activeLive.session);
    const finalBehavior = resolveStreamingBehaviorForPrompt(
      meta?.streamingBehavior,
      activeLive.session.isStreaming,
    );
    if (meta?.streamingBehavior && !finalBehavior) {
      armHangWatchForPrompt();
    }
    const options = buildPromptOptions({
      images,
      streamingBehavior: finalBehavior,
      isStreaming: activeLive.session.isStreaming,
      isHangRetry,
    });
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
  // streaming. promptActive alone is not enough: prepareLive/compaction has
  // not opened a stream yet, and a parallel prompt races the in-flight start.
  if (shouldBypassPromptChain(meta?.streamingBehavior, live.session.isStreaming)) {
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
    model?: string;
    thinkingLevel?: ThinkingLevel;
    subagentPermission?: "allow" | "deny";
    permissionMode?: "allow" | "ask" | "deny";
    skillPermission?: SkillPermission;
    streamingBehavior?: "steer" | "followUp";
    accountIdExplicit?: boolean;
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
  const task = getTask(id);
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  // エージェント定義のmodel/thinkingはサブエージェント起動専用。
  // メイン対話者として直接選択した場合はComposerのモデル/Effortを使う。
  // 同一モデルへの再解決（全アカウントのモデル収集 ≈1.3s）をスキップする。
  // アカウントの現ターン選定は prepareLiveForPrompt が毎回行うため、タスクが
  // 要求のプロバイダ/モデルを既に持つなら付与側の再解決は不要。
  let modelChanged = false;
  if (options?.model) {
    const requested = parseModelValue(options.model);
    const unchanged =
      requested !== null &&
      task.providerID === requested.providerID &&
      task.modelID === requested.modelID &&
      (!requested.accountId || task.accountId === requested.accountId);
    if (!unchanged) {
      await setTaskModel(id, options.model, {
        accountIdExplicit: options.accountIdExplicit,
      });
      modelChanged = true;
    }
  }
  if (
    options?.thinkingLevel &&
    (modelChanged || task.thinkingLevel !== options.thinkingLevel)
  ) {
    await setTaskThinkingLevel(id, options.thinkingLevel);
  }
  const live = await ensureLive(id);
  applySubagentPermission(live.session, options?.subagentPermission);
  persistRevertLeafId(id, null);
  queuePrompt(live, prompt, images, {
    agent: options?.agent,
    subagentPermission: options?.subagentPermission,
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
  applyPermissionMode(live.session, mode);
  return patchTask(id, { permissionMode: mode }) ?? task;
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

/** Fully stop an active Goal Loop before aborting its current Pi request.
 *  The main task "停止" button must terminate the loop (not merely pause it),
 *  so it matches the GoalLoopPanel "停止" action and the button label. */
async function stopGoalLoopForTask(live: LiveRuntime): Promise<void> {
  const loop = readGoalLoopState(
    live.session.sessionManager.getCwd(),
    live.session.sessionId,
  );
  if (!loop || !["queued", "running", "verifying_completed"].includes(loop.status)) return;

  const command = live.session.extensionRunner.getCommand("goal-stop");
  if (!command) return;
  try {
    await command.handler(
      "",
      live.session.extensionRunner.createCommandContext(),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[goal-loop] failed to stop before abort: ${reason}`);
  }
}

export async function abortTask(id: string): Promise<TaskSummary> {
  // An explicit stop is terminal for the current request; do not leave the
  // persisted watchdog armed to wake it up later.
  disarmTaskHangWatch(id);
  clearPendingAttentionForTask(id);
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
    persistManualAbortedAssistantId(id, turnAssistants.at(-1)?.id ?? "");
    await stopGoalLoopForTask(live);
    await stopSubagentRunsForTask(live, msgs);
    // abort() stops the current run but keeps steer/follow-up queues; clear
    // them or the post-run handler will continue with queued messages.
    clearSessionQueue(live.session);
    await live.session.abort();
  }
  const task = setTaskStatus(id, "idle");
  if (!task)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  // 全購読先へ最終状態を送る。idle 保存前に送ると、停止要求元以外のペインが
  // working のまま残り、停止ボタンが再表示される。
  if (live) emitTaskSnapshot(live, "abort", {
    permissionRequest: null,
    questionRequest: null,
  });
  return toSummary(task);
}

/** abort() leaves steer/follow-up queues; drop them so a later run cannot drain stale work. */
export function clearSessionQueue(session: { clearQueue?: () => unknown }): void {
  try {
    session.clearQueue?.();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[abort] clearQueue failed: ${reason}`);
  }
}

/**
 * Hang watchdog abort: stop the stuck turn without disarming resume or
 * goal-loop teardown used by a user stop. Still clear SDK queues so a
 * hang retry cannot also drain leftover steer/follow-up prompts.
 */
export async function abortLiveForHangWatchdog(taskId: string): Promise<void> {
  const live = state().live.get(taskId);
  clearPendingAttentionForTask(taskId);
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
        ? msgs.slice(promptIndex + 1).filter((m) => m.role === "assistant")
        : [];
    persistManualAbortedAssistantId(taskId, turnAssistants.at(-1)?.id ?? "");
    await stopSubagentRunsForTask(live, msgs);
    clearSessionQueue(live.session);
    await live.session.abort();
  }
  setTaskStatus(taskId, "idle");
}

/** Session entry customType for the hidden agent-switch boundary notice. */
const AGENT_SWITCH_CUSTOM_TYPE = "leafcode-pi.agent-switch";

/**
 * The next ensureLive() reopens this same transcript with only the system
 * prompt swapped, so a mid-conversation switch leaves the new persona's
 * context full of the outgoing persona's prior replies, tool calls, and
 * self-description. Without an explicit boundary the model can misidentify
 * which agent it currently is. This text is delivered as a hidden
 * custom_message: excluded from the WebUI timeline (projectPiMessages
 * ignores role "custom") but converted to a plain "user" turn for the LLM on
 * the next session load, the same mechanism compaction/branch summaries use.
 */
function agentSwitchNotice(previousAgent: string | undefined, nextAgent: string): string {
  const previousLabel = previousAgent?.trim() || "the default assistant persona";
  const nextLabel = nextAgent.trim() || "the default assistant persona";
  return [
    `[Session notice] This task's active persona switched from "${previousLabel}" to "${nextLabel}".`,
    `Messages after the most recent agent-switch notice were produced under "${previousLabel}". Earlier messages may belong to other personas.`,
    `You are now "${nextLabel}". Follow only the system prompt currently in effect; do not refer to yourself by the previous persona's name or claim its tools or responsibilities.`,
  ].join("\n");
}

/** Prompt queued, streaming, or compacting: disposing live would drop in-flight work. */
export function isLiveBusyForReplace(live: {
  promptActive?: boolean;
  session: { isStreaming?: boolean; isCompacting?: boolean };
}): boolean {
  return Boolean(live.promptActive || live.session.isStreaming || live.session.isCompacting);
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
  if (isLiveBusyForReplace(live)) {
    throw Object.assign(new Error("実行中タスクのエージェントは変更できません"), {
      status: 409,
    });
  }

  // An empty transcript has no stale persona history to disambiguate.
  if (live.session.messages.length > 0) {
    await live.session.sendCustomMessage({
      customType: AGENT_SWITCH_CUSTOM_TYPE,
      content: agentSwitchNotice(task.agent?.trim(), normalized),
      display: false,
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
  options?: { accountIdExplicit?: boolean },
): Promise<TaskSummary> {
  const task = getTask(id);
  const parsed = parseModelValue(modelValueRaw);
  if (!task || !parsed) {
    throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  }
  const modelRoute = await withRouteLock(
    `${parsed.providerID}::${parsed.modelID}`,
    () =>
      resolveConcreteModelWithFallback(modelValueRaw, parsed.accountId ?? null, {
        accountIdExplicit:
          options?.accountIdExplicit ?? Boolean(parsed.accountId),
        allowProviderFallback: true,
      }),
  );
  if (!modelRoute)
    throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  const targetAccountId = modelRoute.accountId;
  const model = modelRoute.model;
  const targetIds = modelId(model);
  const levels = thinkingLevelsForModel(model);

  // アカウント切替はセッションの再作成が必要。promptActive / ストリーム / 圧縮中は拒否し、
  // それ以外は live セッションを破棄して次回 ensureLive で新しいランタイムから作る。
  // 先に ensureLive を待って作成中セッションとの競合をなくす。
  if (targetAccountId !== (task.accountId ?? null)) {
    const live = await ensureLive(id);
    if (isLiveBusyForReplace(live)) {
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
      providerID: targetIds.providerID ?? parsed.providerID,
      modelID: targetIds.modelID ?? parsed.modelID,
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
  applySessionCompactionSettings(live.session);
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
  if (
    live.session.isCompacting ||
    live.autoCompactionPromise ||
    live.manualCompactionInProgress
  ) {
    throw Object.assign(new Error("コンテキスト圧縮は既に実行中です"), {
      status: 409,
    });
  }
  // Manual compaction aborts the current operation by design. Do not let the
  // hang watchdog replay that operation after compaction succeeds or fails.
  disarmTaskHangWatch(id);
  const instructions = customInstructions?.trim();
  live.manualCompactionInProgress = true;
  try {
    await live.session.compact(instructions || undefined);
  } catch (error) {
    throw mapCompactionError(error);
  } finally {
    live.manualCompactionInProgress = false;
  }
  return getTaskDetail(id);
}

export async function abortTaskCompaction(id: string): Promise<TaskDetail> {
  const live = state().live.get(id);
  if (!live)
    throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  disarmTaskHangWatch(id);
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
  persistRevertLeafId(id, live.revertLeafId);
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
    revertLeafId: live.revertLeafId,
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

/** Persist the pre-revert leaf so restore survives reload and session replace. */
export function persistRevertLeafId(
  taskId: string,
  revertLeafId: string | null,
): void {
  const live = state().live.get(taskId);
  if (live) live.revertLeafId = revertLeafId;
  patchTask(taskId, { revertLeafId });
}

/** Persist the abort sentinel so resume survives reload and session replace. */
export function persistManualAbortedAssistantId(
  taskId: string,
  manualAbortedAssistantId: string | null,
): void {
  const live = state().live.get(taskId);
  if (live) live.manualAbortedAssistantId = manualAbortedAssistantId;
  patchTask(taskId, { manualAbortedAssistantId });
}

/** Persist hang retries so the notice survives reload and session replace. */
export function persistHangRetryCount(taskId: string, hangRetryCount: number): void {
  const live = state().live.get(taskId);
  if (live) live.hangRetryCount = hangRetryCount;
  patchTask(taskId, { hangRetryCount });
}

/** unrevert 用: navigateTree の前に leaf id を保存する（後だと巻き戻し後の位置になる）。 */
export function captureRevertLeafId(
  leafIdBeforeNavigate: string | null,
): string | null {
  return leafIdBeforeNavigate;
}

/** 巻き戻し取消: revert 前の leaf へ戻す。 */
export async function unrevertTask(id: string): Promise<TaskDetail> {
  const live = await ensureLive(id);
  const target = live.revertLeafId ?? getTask(id)?.revertLeafId ?? null;
  if (!target) {
    throw Object.assign(new Error("巻き戻しの対象がありません"), {
      status: 400,
    });
  }
  persistRevertLeafId(id, null);
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
    revertLeafId: null,
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
  settings.applyOverrides({ compaction: { enabled } });
  await settings.flush();
  for (const live of state().live.values()) {
    live.session.setAutoCompactionEnabled(enabled);
    applySessionCompactionSettings(live.session, enabled);
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

export function destroyArchivedTasksByProject(projectId: string | null): {
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

export function clearPendingAttentionForTask(taskId: string): void {
  ensurePermissionPromptService().clearPendingForTask(taskId);
  ensureQuestionPromptService().clearPendingForTask(taskId);
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
