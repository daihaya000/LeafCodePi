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
import { projectPiMessages, titleFromPrompt } from "@/lib/pi/messages";
import {
  buildProviderModelsCatalog,
  enabledModelOptionsFromCatalog,
  type ProviderModelsRow,
} from "@/lib/provider-models";
import {
  setProviderModelDisabled,
  setProviderModelOrder,
} from "@/lib/provider-model-state";
import { registerLlamaProviders, syncLlamaServerProvider } from "@/lib/pi/llama-provider";
import { registerCursorProvider } from "@/lib/pi/cursor-provider";
import { registerCommandCodeProvider } from "@/lib/pi/commandcode-provider";
import { registerOllamaCloudProvider, syncOllamaCloudProvider } from "@/lib/pi/ollama-cloud-provider";
import { readGoalLoopState } from "@/lib/pi/goal-loop-state";
import { todosFromPiMessages } from "@/lib/pi/todowrite-state";
import { toContextUsageDto, type ContextUsageDto } from "@/lib/context-usage";
import { filterSkillsByState } from "@/lib/skills";
import { basenameKey, bundledExtensionEntries, filterExtensionsByState } from "@/lib/extensions";
import { applyPermissionMode, readPermissionGateConfig } from "@/lib/permission-gate-config";
import { buildAgentResourceOptions, loadAgentDefinition } from "@/lib/agents";
import {
  armTaskHangWatch,
  registerHangWatchdogHooks,
  startHangWatchdog,
} from "@/lib/pi/hang-watchdog";
import { HANG_RETRY_PREFIX } from "@/lib/hang-retry";
import { createPermissionPromptService, taskIdForSession } from "@/lib/pi/permission-prompt";
import { registerWebUiPermissionHandler } from "@/lib/pi/webui-permission-bridge";

/** True when a skill lives under the user's ~/.agents directory. */
function isAgentsSkill(skill: { baseDir?: string; filePath?: string }): boolean {
  const agentsRoot = join(homedir(), ".agents");
  const lower = agentsRoot.toLowerCase();
  return (
    (skill.baseDir?.toLowerCase().startsWith(lower) ?? false) ||
    (skill.filePath?.toLowerCase().startsWith(lower) ?? false)
  );
}
import {
  clampThinkingLevelForModel,
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
  HealthDto,
  ModelOption,
  ProjectDto,
  ProviderAuthDto,
  PermissionRequestDto,
  TaskDetail,
  TaskSummary,
  TodoDto,
  ThinkingLevel,
  UiMessage,
} from "@/lib/types";

type PiModule = typeof import("@earendil-works/pi-coding-agent");

type AgentSession = Awaited<ReturnType<PiModule["createAgentSession"]>>["session"];
type ModelRuntime = Awaited<ReturnType<PiModule["ModelRuntime"]["create"]>>;
type Model = NonNullable<AgentSession["model"]>;

export type PromptImage = {
  mimeType: string;
  data: string;
};

/** High-frequency stream events — coalesce snapshot SSE instead of emitting every token. */
const THROTTLED_SNAPSHOT_EVENTS = new Set(["message_update"]);
const SNAPSHOT_THROTTLE_MS = 100;

type LiveRuntime = {
  taskId: string;
  session: AgentSession;
  unsubscribe: () => void;
  promptChain: Promise<void>;
  /** Assistant throughput samples keyed by message.timestamp (ms). */
  throughputByStartedAt: Map<number, ThroughputTiming>;
  /** startedAtMs values already written to the Pi session file. */
  persistedThroughputKeys: Set<number>;
  /** toolCallId → wall-clock start (ms) for live elapsed display. */
  toolStartedAt: Map<string, number>;
  /** toolCallId → wall-clock end (ms), set on tool_execution_end. */
  toolEndedAt: Map<string, number>;
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

type HarnessState = {
  pi: PiModule | null;
  modelRuntime: ModelRuntime | null;
  initError: string | null;
  initPromise: Promise<void> | null;
  live: Map<string, LiveRuntime>;
  events: EventEmitter;
  loginSession: ProviderLoginSession | null;
  healthCache: HealthCacheEntry | null;
  watchdogRegistered: boolean;
  lastProviderSyncWarnings: string[];
};

const GLOBAL_KEY = "__leafcodePiHarness" as const;

/** Coalesce concurrent ensureLive(taskId) so only one Pi session is created. */
const ensureLiveInflight = new Map<string, Promise<LiveRuntime>>();

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
  registerWebUiPermissionHandler((request) => permissionPromptService!.handleRequest(request));
  return permissionPromptService;
}

function state(): HarnessState {
  const globalRef = globalThis as typeof globalThis & { [GLOBAL_KEY]?: HarnessState };
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: null,
      initError: null,
      initPromise: null,
      live: new Map(),
      events: new EventEmitter(),
      loginSession: null,
      healthCache: null,
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
      join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    ];
    for (const pkgPath of candidates) {
      if (!existsSync(/* turbopackIgnore: true */ pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(/* turbopackIgnore: true */ pkgPath, "utf8")) as { version?: string };
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

async function ensureOptionalProviders(runtime: ModelRuntime): Promise<void> {
  // Idempotent: skip when already registered. Safe after HMR / late wiring.
  await registerCursorProvider(runtime);
  await registerCommandCodeProvider(runtime);
  await registerOllamaCloudProvider(runtime);
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
        current.initError = error instanceof Error ? error.message : String(error);
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
          );
          let promptIndex = -1;
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i]?.role === "user") {
              promptIndex = i;
              break;
            }
          }
          const turnAssistants = promptIndex >= 0
            ? msgs.slice(promptIndex + 1).filter((m) => m.role === "assistant")
            : [];
          live.manualAbortedAssistantId = turnAssistants.at(-1)?.id ?? null;
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

function parseModelValue(value: string | undefined): { providerID: string; modelID: string } | null {
  if (!value) return null;
  const separator = value.indexOf("::");
  if (separator <= 0) return null;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 2) };
}

function modelId(model: Model | undefined): { providerID?: string; modelID?: string } {
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
    const responseDurationMs = Math.max(0, (timing.lastTokenAtMs ?? nowMs) - timing.startedAtMs);
    const snap = snapshotThroughput(timing, nowMs);
    if (!snap || snap.tokensPerSecond === null) {
      return responseDurationMs > 0 ? { ...message, responseDurationMs } : message;
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

function snapshotMessages(
  session: AgentSession,
  throughputByStartedAt?: Map<number, ThroughputTiming>,
  toolStartedAt?: Map<string, number>,
  toolEndedAt?: Map<string, number>,
): UiMessage[] {
  const stored: unknown[] = Array.isArray(session.messages) ? [...session.messages] : [];
  const streaming = session.agent.state.streamingMessage;
  if (streaming && stored[stored.length - 1] !== streaming) {
    stored.push(streaming);
  }
  let projected = projectPiMessages(stored);
  if (throughputByStartedAt) projected = applyThroughput(projected, throughputByStartedAt);
  if (toolStartedAt && toolStartedAt.size > 0 && toolEndedAt) {
    projected = applyToolTiming(projected, toolStartedAt, toolEndedAt);
  }
  return projected;
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

function persistThroughputSample(live: LiveRuntime, timing: ThroughputTiming): void {
  if (live.persistedThroughputKeys.has(timing.startedAtMs)) return;
  const payload = toPersistedThroughput(timing);
  if (!payload) return;
  // Defer until after Pi appends the assistant message on message_end.
  queueMicrotask(() => {
    if (live.persistedThroughputKeys.has(timing.startedAtMs)) return;
    try {
      live.session.sessionManager.appendCustomEntry(THROUGHPUT_CUSTOM_TYPE, payload);
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
  if (!usage || typeof usage.output !== "number" || !Number.isFinite(usage.output)) return null;
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

  if (event.type === "tool_execution_end") {
    const toolCallId =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : typeof event.toolCallID === "string"
          ? event.toolCallID
          : "";
    if (toolCallId) live.toolEndedAt.set(toolCallId, Date.now());
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
      live.throughputByStartedAt.set(startedAt, createThroughputTiming(startedAt));
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
    let timing = live.throughputByStartedAt.get(startedAt) ?? createThroughputTiming(startedAt);
    timing = noteReportedOutputTokens(timing, assistantUsageOutput(message));
    if (timing.lastTokenAtMs === null) {
      timing = { ...timing, lastTokenAtMs: Date.now() };
    }
    live.throughputByStartedAt.set(startedAt, timing);
    persistThroughputSample(live, timing);
  }
}

function sessionContextUsage(session: AgentSession): ContextUsageDto | undefined {
  try {
    return toContextUsageDto(session.getContextUsage());
  } catch {
    return undefined;
  }
}

function sessionSnapshotFields(
  session: AgentSession,
  throughputByStartedAt?: Map<number, ThroughputTiming>,
  toolStartedAt?: Map<string, number>,
  toolEndedAt?: Map<string, number>,
): {
  messages: UiMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  contextUsage: ContextUsageDto | undefined;
  goalLoop: GoalLoopDto | null;
  todos: TodoDto[];
} {
  return {
    messages: snapshotMessages(session, throughputByStartedAt, toolStartedAt, toolEndedAt),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    contextUsage: sessionContextUsage(session),
    goalLoop: readGoalLoopState(session.sessionManager.getCwd(), session.sessionId),
    todos: todosFromPiMessages(session.messages),
  };
}

function emit(taskId: string, payload: { type: string; [key: string]: unknown }): void {
  state().events.emit(taskId, payload);
  state().events.emit("*", { taskId, ...payload });
}

/** プロバイダが「思考オフ不可」の 400 を返したか。 */
export function isReasoningMandatoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reasoning is mandatory/i.test(message);
}

/** 思考必須モデル向けのフォールバックレベル（対応する最下位、なければ minimal）。 */
export function reasoningFallbackLevel(model: Model | null | undefined): ThinkingLevel {
  const levels = model ? thinkingLevelsForModel(model).filter((l) => l !== "off") : [];
  return levels[0] ?? "minimal";
}

function emitTaskSnapshot(
  live: LiveRuntime,
  eventType: string,
  extra?: Record<string, unknown>,
): void {
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
    ),
    manualAbortedAssistantId: live.manualAbortedAssistantId,
    hangRetryCount: live.hangRetryCount,
    eventType,
    ...extra,
  });
}

function scheduleTaskSnapshot(
  live: LiveRuntime,
  eventType: string,
  extra?: Record<string, unknown>,
): void {
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
    emitTaskSnapshot(live, pendingType);
  }, SNAPSHOT_THROTTLE_MS);
}

function mapCompactionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Nothing to compact/i.test(message)) {
    return Object.assign(new Error("圧縮するほど履歴がありません"), { status: 400 });
  }
  if (/Already compacted/i.test(message)) {
    return Object.assign(new Error("すでに圧縮済みです"), { status: 400 });
  }
  if (/Compaction cancelled/i.test(message) || (error instanceof Error && error.name === "AbortError")) {
    return Object.assign(new Error("圧縮をキャンセルしました"), { status: 400 });
  }
  return error instanceof Error ? error : new Error(message);
}

function openSettingsManager() {
  const pi = state().pi;
  if (!pi) throw Object.assign(new Error("Pi ランタイムが初期化されていません"), { status: 503 });
  return pi.SettingsManager.create(homedir(), pi.getAgentDir());
}

function attachSession(taskId: string, session: AgentSession): LiveRuntime {
  const current = state();
  const existing = current.live.get(taskId);
  existing?.unsubscribe();
  const replacedSession = existing?.session;
  if (replacedSession && replacedSession !== session) {
    replacedSession.dispose();
  }

  const loaded = existing
    ? null
    : loadThroughputFromSession(session);

  if (existing?.snapshotTimer) {
    clearTimeout(existing.snapshotTimer);
  }

  const live: LiveRuntime = {
    taskId,
    session,
    unsubscribe: () => undefined,
    promptChain: Promise.resolve(),
    throughputByStartedAt: existing?.throughputByStartedAt ?? loaded?.timings ?? new Map(),
    persistedThroughputKeys:
      existing?.persistedThroughputKeys ?? loaded?.persistedKeys ?? new Set(),
    toolStartedAt: existing?.toolStartedAt ?? new Map(),
    toolEndedAt: existing?.toolEndedAt ?? new Map(),
    snapshotTimer: null,
    pendingSnapshotEventType: null,
    revertLeafId: null,
    manualAbortedAssistantId: null,
    hangRetryCount: 0,
    reasoningFallbackTried: false,
  };

  const unsubscribe = session.subscribe((event) => {
    const task = getTask(taskId);
    if (!task) return;
    trackThroughputEvent(live, event as { type: string; [key: string]: unknown });
    const ids = modelId(session.model);
    if (event.type === "agent_start") {
      setTaskStatus(taskId, "working");
    }
    if (event.type === "agent_settled" || (event.type === "agent_end" && !event.willRetry)) {
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
    if (ids.providerID || ids.modelID) {
      patchTask(taskId, {
        providerID: ids.providerID,
        modelID: ids.modelID,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
      });
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
        emitTaskSnapshot(live, pendingType);
      }
    }
    unsubscribe();
  };
  current.live.set(taskId, live);
  return live;
}

async function createSession(options: {
  cwd: string;
  sessionFile?: string | null;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  subagentPermission?: "allow" | "deny";
  permissionMode?: "allow" | "ask" | "deny";
  /** pi-subagents agent running as the main session persona. */
  agentName?: string | null;
}): Promise<AgentSession> {
  const pi = await loadPi();
  await ensureRuntime();
  const agentDir = pi.getAgentDir();
  const sessionManager = options.sessionFile
    ? pi.SessionManager.open(options.sessionFile)
    : pi.SessionManager.create(options.cwd);
  // Filter disabled skills via state file (skills-state.json), not folder moves.
  // skillsOverride re-reads state on every resourceLoader.reload() / session.reload().
  // Also drop any ~/.agents skills Pi loads internally: this harness must not
  // read C:\Users\Daichi\.agents (skills.ts discovery already excludes it).
  // Bundled WebUI extensions (goal-loop / todowrite / permission-gate) load
  // straight from this repository's extensions/ dir; stale same-name copies
  // under ~/.pi are dropped so they never register duplicate tools.
  const bundled = bundledExtensionEntries();
  const bundledNames = new Set(bundled.map((entry) => entry.name));
  const bundledPaths = new Set(bundled.map((entry) => entry.filePath));
  // The bundled leafcode-subagents fork replaces the npm pi-subagents package:
  // drop the npm extension so the `subagent` tool is never registered twice.
  const forkOwnsSubagents = bundledNames.has("leafcode-subagents");
  // Selected agent becomes the main persona: its system prompt replaces (or
  // appends to) the base prompt, and context files / skills follow the agent's
  // inherit flags — mirroring how pi-subagents launches child sessions.
  const agentDefinition = options.agentName
    ? loadAgentDefinition(options.agentName, agentDir)
    : undefined;
  const agentOptions = agentDefinition ? buildAgentResourceOptions(agentDefinition) : undefined;
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    additionalExtensionPaths: bundled.map((entry) => entry.filePath),
    skillsOverride: agentOptions?.noSkills
      ? () => ({ skills: [], diagnostics: [] })
      : (base) => ({
          skills: filterSkillsByState(base.skills).filter((skill) => !isAgentsSkill(skill)),
          diagnostics: base.diagnostics,
        }),
    extensionsOverride: (base) => ({
      ...base,
      extensions: filterExtensionsByState(
        base.extensions.filter(
          (extension) =>
            !(forkOwnsSubagents && basenameKey(extension.path) === "pi-subagents") &&
            (!bundledNames.has(basenameKey(extension.path)) || bundledPaths.has(resolve(extension.path))),
        ),
      ),
    }),
    ...(agentOptions?.systemPrompt ? { systemPrompt: agentOptions.systemPrompt } : {}),
    ...(agentOptions?.appendSystemPrompt ? { appendSystemPrompt: agentOptions.appendSystemPrompt } : {}),
    ...(agentOptions?.noContextFiles ? { noContextFiles: true } : {}),
  });
  await resourceLoader.reload();
  const permissionMode = options.permissionMode ?? readPermissionGateConfig(options.cwd);
  const persistPermission = options.permissionMode !== undefined;
  applyPermissionMode({ extensionRunner: undefined }, options.cwd, permissionMode, {
    persist: persistPermission,
  });
  // Agent-defined tool allowlist wins; otherwise default tools. The `subagent`
  // tool is only exposed when subagent permission is "allow" (delegation stays
  // independent from running an agent as the main persona).
  const tools =
    agentOptions?.tools ??
    (options.subagentPermission === "allow"
      ? ["read", "write", "edit", "bash", "grep", "find", "ls", "subagent", "todowrite"]
      : ["read", "write", "edit", "bash", "grep", "find", "ls", "todowrite"]);
  const result = await pi.createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager,
    resourceLoader,
    modelRuntime: state().modelRuntime ?? undefined,
    tools,
  });
  applyPermissionMode(result.session, options.cwd, permissionMode, {
    persist: persistPermission,
  });
  return result.session;
}

async function resolveModel(value: string | undefined): Promise<Model | undefined> {
  await ensureRuntime();
  const runtime = state().modelRuntime;
  if (!runtime) return undefined;
  const parsed = parseModelValue(value);
  if (!parsed) return undefined;
  const found = runtime.getModel(parsed.providerID, parsed.modelID);
  return found ?? undefined;
}

function toSummary(task: TaskSummary): TaskSummary {
  const live = state().live.get(task.id);
  if (!live) return task;
  const ids = modelId(live.session.model);
  const thinking =
    typeof live.session.thinkingLevel === "string" && isThinkingLevel(live.session.thinkingLevel)
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
    if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
    const project = getProject(task.projectId);
    const cwd = project?.rootPath ?? task.directory;
    const model = await resolveModel(
      task.providerID && task.modelID ? modelValue(task.providerID, task.modelID) : undefined,
    );
    const session = await createSession({
      cwd,
      sessionFile: task.sessionFile,
      model,
      thinkingLevel: task.thinkingLevel,
      agentName: task.agent ?? null,
    });
    patchTask(taskId, {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      ...modelId(session.model),
    });
    return attachSession(taskId, session);
  })().finally(() => {
    if (ensureLiveInflight.get(taskId) === promise) {
      ensureLiveInflight.delete(taskId);
    }
  });

  ensureLiveInflight.set(taskId, promise);
  return promise;
}

function validateProjectPath(rootPath: string): { ok: true; path: string } | { ok: false; error: string } {
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

async function syncProvidersBestEffort(runtime: ModelRuntime): Promise<string[]> {
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

type HealthCacheEntry = { at: number; value: HealthDto };

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
export function nextHealthCache(value: HealthDto, now: number): HealthCacheEntry | null {
  return value.engineOk ? { at: now, value } : null;
}

/** Drop the cached snapshot after anything that can change the model list. */
export function invalidateHealthCache(): void {
  state().healthCache = null;
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
  const models = current.modelRuntime ? await listModels().catch(() => []) : [];
  const value: HealthDto = {
    ok: !current.initError,
    engine: "pi",
    engineOk: !current.initError && models.length > 0,
    version: packageVersion(),
    modelCount: models.length,
    dataDir: dataDir(),
    error: current.initError,
    ...(current.lastProviderSyncWarnings.length > 0
      ? { warnings: [...current.lastProviderSyncWarnings] }
      : {}),
  };
  current.healthCache = nextHealthCache(value, Date.now());
  return value;
}

export async function listModels(): Promise<ModelOption[]> {
  await ensureRuntime();
  const runtime = state().modelRuntime;
  if (!runtime) return [];
  await syncProvidersBestEffort(runtime);
  const catalog = buildProviderModelsCatalog(runtime);
  const enabled = new Set(
    enabledModelOptionsFromCatalog(catalog).map((option) => option.value),
  );
  const available = await runtime.getAvailable();
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
  const order = enabledModelOptionsFromCatalog(catalog).map((option) => option.value);
  const rank = new Map(order.map((value, index) => [value, index]));
  options.sort((a, b) => (rank.get(a.value) ?? 1e9) - (rank.get(b.value) ?? 1e9));
  return options;
}

export async function listProviderModelsCatalog(): Promise<ProviderModelsRow[]> {
  await ensureRuntime();
  const runtime = state().modelRuntime;
  if (!runtime) return [];
  return buildProviderModelsCatalog(runtime);
}

export async function setProviderOrModelEnabled(key: string, enabled: boolean): Promise<void> {
  if (!key.trim()) throw Object.assign(new Error("key が必要です"), { status: 400 });
  await setProviderModelDisabled(key, !enabled);
  invalidateHealthCache();
}

export async function saveProviderModelsOrder(input: {
  providerOrder?: string[];
  modelOrder?: Record<string, string[]>;
}): Promise<void> {
  await setProviderModelOrder(input);
  invalidateHealthCache();
}

export async function listProviderAuth(): Promise<ProviderAuthDto[]> {
  await ensureRuntime();
  const runtime = state().modelRuntime;
  if (!runtime) return [];
  const providers = runtime.getProviders().map((provider) => {
    const status = runtime.getProviderAuthStatus(provider.id);
    const methods = providerAuthMethods(provider);
    return {
      id: provider.id,
      name: provider.name,
      authenticated: status.configured,
      methods,
      authSource: status.source,
      authLabel: status.label,
      subscription: runtime.isUsingSubscription(provider.id),
      oauthAvailable: methods.includes("oauth"),
      highlighted: isHighlightedProvider(provider.id),
    } satisfies ProviderAuthDto;
  });
  providers.sort((a, b) => {
    const score = (p: ProviderAuthDto) =>
      (p.highlighted ? 4 : 0) + (p.oauthAvailable ? 2 : 0) + (p.authenticated ? 1 : 0);
    return score(b) - score(a) || a.name.localeCompare(b.name, "en");
  });
  return providers;
}

export async function startProviderLogin(
  providerId: string,
  authType: AuthTypeDto,
): Promise<{ sessionId: string }> {
  await ensureRuntime();
  const current = state();
  const runtime = current.modelRuntime;
  if (!runtime) throw Object.assign(new Error("Pi runtime が初期化されていません"), { status: 503 });
  const provider = runtime.getProvider(providerId);
  if (!provider) throw Object.assign(new Error(`不明なプロバイダー: ${providerId}`), { status: 404 });
  const methods = providerAuthMethods(provider);
  if (!methods.includes(authType)) {
    throw Object.assign(
      new Error(`${provider.name} は ${authType === "oauth" ? "サブスクログイン" : "API キー"} に対応していません`),
      { status: 400 },
    );
  }
  if (current.loginSession) {
    current.loginSession.cancel();
    current.loginSession = null;
  }
  const session = new ProviderLoginSession(providerId, authType);
  current.loginSession = session;
  // Let the SSE client attach before the OAuth flow emits prompts.
  queueMicrotask(() => {
    void session.run(runtime).finally(() => {
      // A successful login usually adds models, so drop the cached health snapshot.
      invalidateHealthCache();
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
  if (!session) throw Object.assign(new Error("ログインセッションがありません"), { status: 409 });
  session.answer(promptId, value);
}

export function cancelProviderLogin(): void {
  const current = state();
  current.loginSession?.cancel();
  current.loginSession = null;
}

export function subscribeProviderLogin(listener: (event: LoginSessionEvent) => void): () => void {
  const session = state().loginSession;
  if (!session) throw Object.assign(new Error("ログインセッションがありません"), { status: 409 });
  return session.subscribe(listener);
}

export function getActiveProviderLogin(): { sessionId: string; providerId: string; authType: AuthTypeDto } | null {
  const session = state().loginSession;
  if (!session) return null;
  return { sessionId: session.id, providerId: session.providerId, authType: session.authType };
}

export async function logoutProvider(providerId: string): Promise<void> {
  await ensureRuntime();
  const runtime = state().modelRuntime;
  if (!runtime) throw Object.assign(new Error("Pi runtime が初期化されていません"), { status: 503 });
  if (!runtime.getProvider(providerId)) {
    throw Object.assign(new Error(`不明なプロバイダー: ${providerId}`), { status: 404 });
  }
  await runtime.logout(providerId);
  invalidateHealthCache();
}

export function getProjects(includeArchived = false): ProjectDto[] {
  return listProjects(includeArchived);
}

export function addProject(rootPath: string): ProjectDto {
  const validated = validateProjectPath(rootPath);
  if (!validated.ok) throw Object.assign(new Error(validated.error), { status: 400 });
  return upsertProject({
    name: basename(validated.path) || "Untitled",
    rootPath: validated.path,
  });
}

export function archiveProject(id: string): ProjectDto {
  const project = patchProject(id, { archived: true });
  if (!project) throw Object.assign(new Error("プロジェクトが見つかりません"), { status: 404 });
  return project;
}

export function getTaskSummaries(includeArchived = false): TaskSummary[] {
  return listTasks(includeArchived).map(toSummary);
}

export async function getTaskDetail(id: string): Promise<TaskDetail> {
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
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
    );
    messages = fields.messages;
    isStreaming = fields.isStreaming;
    isCompacting = fields.isCompacting;
    contextUsage = fields.contextUsage;
    goalLoop = fields.goalLoop;
    todos = fields.todos;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 503 });
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
  };
}

export async function goalLoopState(taskId: string): Promise<GoalLoopDto | null> {
  const live = await ensureLive(taskId);
  return readGoalLoopState(live.session.sessionManager.getCwd(), live.session.sessionId);
}

export async function goalLoopCommand(
  taskId: string,
  input:
    | { action: "start"; goal: string; acceptance?: string[]; maxTurns?: number; forceFullRun?: boolean }
    | { action: "pause" | "resume" | "stop"; maxTurns?: number },
): Promise<GoalLoopDto | null> {
  const live = await ensureLive(taskId);
  let command: string;
  if (input.action === "start") {
    const payload = Buffer.from(
      JSON.stringify({
        goal: input.goal,
        acceptance: input.acceptance ?? [],
        maxTurns: input.maxTurns,
        forceFullRun: input.forceFullRun === true,
      }),
      "utf8",
    ).toString("base64url");
    command = `/goal-start ${payload}`;
  } else if (input.action === "resume" && input.maxTurns) {
    command = `/goal-resume --turns ${Math.trunc(input.maxTurns)}`;
  } else {
    command = `/goal-${input.action}`;
  }
  await live.session.prompt(command);
  return readGoalLoopState(live.session.sessionManager.getCwd(), live.session.sessionId);
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
  goalLoop?: {
    acceptance?: string[];
    maxTurns?: number;
    forceFullRun?: boolean;
  };
}): Promise<TaskSummary> {
  const project = getProject(input.projectId);
  if (!project) throw Object.assign(new Error("プロジェクトが見つかりません"), { status: 404 });
  patchProject(project.id, { lastOpenedAt: new Date().toISOString() });
  const parsed = parseModelValue(input.model);
  const task = insertTask({
    project,
    title: titleFromPrompt(input.prompt),
    thinkingLevel: input.thinkingLevel,
    providerID: parsed?.providerID,
    modelID: parsed?.modelID,
    ...(input.agent ? { agent: input.agent.trim() } : {}),
  });
  const model = await resolveModel(input.model);
  const requestedThinking = isThinkingLevel(input.thinkingLevel) ? input.thinkingLevel : "off";
  const thinkingLevel = model
    ? clampThinkingLevelForModel(model, requestedThinking)
    : requestedThinking;
  const session = await createSession({
    cwd: project.rootPath,
    model,
    thinkingLevel,
    subagentPermission: input.subagentPermission,
    permissionMode: input.permissionMode,
    // The selected agent talks as the main persona for this whole session.
    agentName: input.agent ?? null,
  });
  patchTask(task.id, {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    status: "working",
    thinkingLevel:
      isThinkingLevel(session.thinkingLevel) ? session.thinkingLevel : thinkingLevel,
    ...modelId(session.model),
  });
  const live = attachSession(task.id, session);
  if (input.goalLoop) {
    await goalLoopCommand(task.id, {
      action: "start",
      goal: input.prompt,
      acceptance: input.goalLoop.acceptance,
      maxTurns: input.goalLoop.maxTurns,
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
  },
): void {
  const isHangRetry = meta?.isHangRetry === true || prompt.startsWith(HANG_RETRY_PREFIX);
  live.manualAbortedAssistantId = null;
  armTaskHangWatch({
    taskId: live.taskId,
    prompt,
    images,
    ...(meta?.agent ? { agent: meta.agent } : {}),
    ...(meta?.subagentPermission ? { subagentPermission: meta.subagentPermission } : {}),
    ...(meta?.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    isHangRetry,
  });
  live.promptChain = live.promptChain
    .then(async () => {
      setTaskStatus(live.taskId, "working");
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
      if (live.session.isStreaming) {
        options.streamingBehavior = "followUp";
      }
      try {
        await live.session.prompt(prompt, options);
      } catch (error) {
        // 一部モデル（o系/gpt-5-pro 等）は思考オフ不可の 400 を返す。
        // 思考レベルを引き上げて同じプロンプトを一度だけ再試行する。
        if (!isReasoningMandatoryError(error) || live.reasoningFallbackTried) throw error;
        live.reasoningFallbackTried = true;
        const level = reasoningFallbackLevel(live.session.model);
        if (live.session.thinkingLevel !== level) live.session.setThinkingLevel(level);
        patchTask(live.taskId, { thinkingLevel: level });
        emitTaskSnapshot(live, "thinking_level_changed", { thinkingLevel: level });
        await live.session.prompt(prompt, options);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setTaskStatus(live.taskId, "error", message);
      emit(live.taskId, {
        type: "snapshot",
        task: toSummary(getTask(live.taskId)!),
        ...sessionSnapshotFields(
        live.session,
        live.throughputByStartedAt,
        live.toolStartedAt,
        live.toolEndedAt,
      ),
        isStreaming: false,
        eventType: "error",
        error: message,
      });
    });
}

export async function promptTask(
  id: string,
  prompt: string,
  images?: PromptImage[],
  options?: { agent?: string; subagentPermission?: "allow" | "deny"; permissionMode?: "allow" | "ask" | "deny" },
): Promise<TaskSummary> {
  const live = await ensureLive(id);
  applySubagentPermission(live.session, options?.subagentPermission);
  if (options?.permissionMode) {
    const task = getTask(id);
    const project = task ? getProject(task.projectId) : undefined;
    const cwd = project?.rootPath ?? live.session.sessionManager.getCwd();
    applyPermissionMode(live.session, cwd, options.permissionMode);
  }
  live.revertLeafId = null;
  queuePrompt(live, prompt, images, options);
  return toSummary(getTask(id)!);
}

export async function setTaskPermissionMode(
  id: string,
  mode: "allow" | "ask" | "deny",
): Promise<TaskSummary> {
  const live = await ensureLive(id);
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
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
  if (typeof session.setActiveToolsByName !== "function" || typeof session.getActiveToolNames !== "function") {
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

export async function abortTask(id: string): Promise<TaskSummary> {
  const live = state().live.get(id);
  if (live) {
    const msgs = snapshotMessages(
      live.session,
      live.throughputByStartedAt,
      live.toolStartedAt,
      live.toolEndedAt,
    );
    let promptIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === "user") {
        promptIndex = i;
        break;
      }
    }
    const turnAssistants =
      promptIndex >= 0 ? msgs.slice(promptIndex + 1).filter((m) => m.role === "assistant") : [];
    live.manualAbortedAssistantId = turnAssistants.at(-1)?.id ?? null;
    await live.session.abort();
    emitTaskSnapshot(live, "abort");
  }
  const task = setTaskStatus(id, "idle");
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return toSummary(task);
}

export async function setTaskModel(id: string, modelValueRaw: string): Promise<TaskSummary> {
  const live = await ensureLive(id);
  const parsed = parseModelValue(modelValueRaw);
  const model = await resolveModel(modelValueRaw);
  if (!model || !parsed) throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  await live.session.setModel(model);
  const ids = modelId(live.session.model ?? model);
  const thinkingLevel = clampThinkingLevelForModel(
    model,
    isThinkingLevel(live.session.thinkingLevel)
      ? live.session.thinkingLevel
      : getTask(id)?.thinkingLevel,
  );
  if (live.session.thinkingLevel !== thinkingLevel) {
    live.session.setThinkingLevel(thinkingLevel);
  }
  const task = patchTask(id, {
    providerID: ids.providerID ?? parsed.providerID,
    modelID: ids.modelID ?? parsed.modelID,
    thinkingLevel,
  });
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const summary = toSummary(task);
  emit(id, {
    type: "snapshot",
    task: summary,
    ...sessionSnapshotFields(
        live.session,
        live.throughputByStartedAt,
        live.toolStartedAt,
        live.toolEndedAt,
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
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const summary = toSummary(task);
  emit(id, {
    type: "snapshot",
    task: summary,
    ...sessionSnapshotFields(
        live.session,
        live.throughputByStartedAt,
        live.toolStartedAt,
        live.toolEndedAt,
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
    throw Object.assign(new Error("コンテキスト圧縮は既に実行中です"), { status: 409 });
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
  if (!live) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  live.session.abortCompaction();
  return getTaskDetail(id);
}

/**
 * 巻き戻し: 指定ユーザーメッセージ（UI のメッセージ id）以降を破棄し、その
 * 内容を text / images として返す（本家 LeafCode の「入力欄に戻す」と同じ）。
 * Pi コアの navigateTree は user メッセージをターゲットにすると leaf を親へ
 * 移し、破棄した分の入力を editorText として返す。
 */
export async function revertTask(id: string, messageId: string): Promise<{
  task: TaskDetail;
  text: string;
  images: { uri: string; mime: string; name?: string }[];
}> {
  const live = await ensureLive(id);
  if (live.session.isStreaming) {
    throw Object.assign(new Error("応答中は巻き戻せません。停止してからお試しください"), {
      status: 409,
    });
  }
  const entry = messageEntryById(live.session, messageId);
  if (!entry) {
    throw Object.assign(new Error("対象メッセージが見つかりません"), { status: 404 });
  }
  if (entry.message.role !== "user") {
    throw Object.assign(new Error("ユーザーメッセージのみ入力欄に戻せます"), { status: 400 });
  }
  const previousLeafId = live.session.sessionManager.getLeafId();
  const result = await live.session.navigateTree(entry.id);
  if (result.cancelled) {
    throw Object.assign(new Error("巻き戻しがキャンセルされました"), { status: 400 });
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
    ),
    eventType: "revert",
  });
  return { task: taskDetail, text: result.editorText ?? "", images: imagesFromEntry(entry) };
}

/** UI のメッセージ id（エージェント側）からセッションエントリを取り出す。 */
export function messageEntryById(
  session: AgentSession,
  messageId: string,
): { id: string; message: { role: string; content: unknown } } | null {
  try {
    for (const entry of session.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object") continue;
      if ((message as { id?: unknown }).id === messageId) {
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
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const images: { uri: string; mime: string; name?: string }[] = [];
  content.forEach((block, index) => {
    if (!block || typeof block !== "object") return;
    const record = block as { type?: unknown; mimeType?: unknown; data?: unknown; filename?: unknown };
    if (record.type !== "image") return;
    const data = typeof record.data === "string" ? record.data : "";
    if (!data) return;
    const mime = typeof record.mimeType === "string" && record.mimeType ? record.mimeType : "image/png";
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
export function captureRevertLeafId(leafIdBeforeNavigate: string | null): string | null {
  return leafIdBeforeNavigate;
}

/** 巻き戻し取消: revert 前の leaf へ戻す。 */
export async function unrevertTask(id: string): Promise<TaskDetail> {
  const live = state().live.get(id);
  if (!live) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const target = live.revertLeafId;
  if (!target) {
    throw Object.assign(new Error("巻き戻しの対象がありません"), { status: 400 });
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
    ),
    eventType: "unrevert",
  });
  return taskDetail;
}

export async function getCompactionSettings(): Promise<CompactionSettingsDto> {
  await ensureRuntime();
  return openSettingsManager().getCompactionSettings();
}

export async function setCompactionEnabled(enabled: boolean): Promise<CompactionSettingsDto> {
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
  const live = state().live.get(id);
  if (live) {
    live.unsubscribe();
    live.session.dispose();
    state().live.delete(id);
  }
  const task = setTaskStatus(id, "archived");
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return task;
}

export function restoreTask(id: string): TaskSummary {
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  if (task.status !== "archived") throw Object.assign(new Error("アーカイブされたタスクのみ復元できます"), { status: 400 });
  return patchTask(id, { status: "idle" }) ?? task;
}

export function destroyTask(id: string): { ok: true } {
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  const live = state().live.get(id);
  if (live) {
    live.unsubscribe();
    live.session.dispose();
    state().live.delete(id);
  }
  deleteTask(id);
  return { ok: true };
}

export function destroyArchivedTasksByProject(projectId: string): { ok: true; removed: number } {
  const tasks = listTasks(true).filter((task) => task.projectId === projectId && task.status === "archived");
  for (const task of tasks) {
    const live = state().live.get(task.id);
    if (live) {
      live.unsubscribe();
      live.session.dispose();
      state().live.delete(task.id);
    }
    deleteTask(task.id);
  }
  return { ok: true, removed: tasks.length };
}

export function restoreProject(id: string): ProjectDto {
  const project = patchProject(id, { archived: false });
  if (!project) throw Object.assign(new Error("プロジェクトが見つかりません"), { status: 404 });
  return project;
}

export function destroyProject(id: string): { ok: true } {
  const project = getProject(id);
  if (!project) throw Object.assign(new Error("プロジェクトが見つかりません"), { status: 404 });
  const tasks = listTasks(true).filter((task) => task.projectId === id);
  for (const task of tasks) {
    const live = state().live.get(task.id);
    if (live) {
      live.unsubscribe();
      live.session.dispose();
      state().live.delete(task.id);
    }
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

export function pendingPermissionForTask(taskId: string): PermissionRequestDto | null {
  return ensurePermissionPromptService().pendingForTask(taskId);
}

export function respondToPermissionPrompt(
  taskId: string,
  requestId: string,
  approved: boolean,
): boolean {
  return ensurePermissionPromptService().respond(taskId, requestId, approved);
}

export function jsonError(error: unknown, fallbackStatus = 500): { error: string; status: number } {
  const status =
    typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? error.status
      : fallbackStatus;
  return {
    error: error instanceof Error ? error.message : String(error),
    status,
  };
}
