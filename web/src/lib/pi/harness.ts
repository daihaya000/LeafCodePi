import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, isAbsolutePath } from "@/lib/paths";
import {
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
import { registerOllamaCloudProvider, syncOllamaCloudProvider } from "@/lib/pi/ollama-cloud-provider";
import { toContextUsageDto, type ContextUsageDto } from "@/lib/context-usage";
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
  HealthDto,
  ModelOption,
  ProjectDto,
  ProviderAuthDto,
  TaskDetail,
  TaskSummary,
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

type LiveRuntime = {
  taskId: string;
  session: AgentSession;
  unsubscribe: () => void;
  promptChain: Promise<void>;
  /** Assistant throughput samples keyed by message.timestamp (ms). */
  throughputByStartedAt: Map<number, ThroughputTiming>;
  /** startedAtMs values already written to the Pi session file. */
  persistedThroughputKeys: Set<number>;
};

type HarnessState = {
  pi: PiModule | null;
  modelRuntime: ModelRuntime | null;
  initError: string | null;
  initPromise: Promise<void> | null;
  live: Map<string, LiveRuntime>;
  events: EventEmitter;
  loginSession: ProviderLoginSession | null;
};

const GLOBAL_KEY = "__leafcodePiHarness" as const;

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
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
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

async function ensureRuntime(): Promise<void> {
  const current = state();
  if (current.modelRuntime) return;
  if (!current.initPromise) {
    current.initPromise = (async () => {
      try {
        const pi = await loadPi();
        current.modelRuntime = await pi.ModelRuntime.create({
          allowModelNetwork: true,
          modelRefreshTimeoutMs: 8_000,
        });
        await registerLlamaProviders(current.modelRuntime);
        await registerCursorProvider(current.modelRuntime);
        await registerOllamaCloudProvider(current.modelRuntime);
        current.initError = null;
      } catch (error) {
        current.initError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    })();
  }
  await current.initPromise;
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

function applyThroughput(
  messages: UiMessage[],
  throughputByStartedAt: Map<number, ThroughputTiming>,
): UiMessage[] {
  if (throughputByStartedAt.size === 0) return messages;
  const nowMs = Date.now();
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const timing = throughputByStartedAt.get(message.createdAt);
    if (!timing) return message;
    const snap = snapshotThroughput(timing, nowMs);
    if (!snap || snap.tokensPerSecond === null) return message;
    return {
      ...message,
      outputTokens: snap.outputTokens,
      tokensPerSecond: snap.tokensPerSecond,
      tokensPerSecondDecode: snap.decodePhase,
    };
  });
}

function snapshotMessages(
  session: AgentSession,
  throughputByStartedAt?: Map<number, ThroughputTiming>,
): UiMessage[] {
  const stored: unknown[] = Array.isArray(session.messages) ? [...session.messages] : [];
  const streaming = session.agent.state.streamingMessage;
  if (streaming && stored[stored.length - 1] !== streaming) {
    stored.push(streaming);
  }
  const projected = projectPiMessages(stored);
  return throughputByStartedAt ? applyThroughput(projected, throughputByStartedAt) : projected;
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
): {
  messages: UiMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  contextUsage: ContextUsageDto | undefined;
} {
  return {
    messages: snapshotMessages(session, throughputByStartedAt),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    contextUsage: sessionContextUsage(session),
  };
}

function emit(taskId: string, payload: { type: string; [key: string]: unknown }): void {
  state().events.emit(taskId, payload);
  state().events.emit("*", { taskId, ...payload });
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

  const loaded = existing
    ? null
    : loadThroughputFromSession(session);

  const live: LiveRuntime = {
    taskId,
    session,
    unsubscribe: () => undefined,
    promptChain: Promise.resolve(),
    throughputByStartedAt: existing?.throughputByStartedAt ?? loaded?.timings ?? new Map(),
    persistedThroughputKeys:
      existing?.persistedThroughputKeys ?? loaded?.persistedKeys ?? new Set(),
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
    emit(taskId, {
      type: "snapshot",
      task: toSummary(getTask(taskId) ?? task),
      ...sessionSnapshotFields(session, live.throughputByStartedAt),
      eventType: event.type,
      ...(event.type === "compaction_end" && event.errorMessage
        ? { error: event.errorMessage }
        : {}),
    });
  });

  live.unsubscribe = unsubscribe;
  current.live.set(taskId, live);
  return live;
}

async function createSession(options: {
  cwd: string;
  sessionFile?: string | null;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}): Promise<AgentSession> {
  const pi = await loadPi();
  await ensureRuntime();
  const sessionManager = options.sessionFile
    ? pi.SessionManager.open(options.sessionFile)
    : pi.SessionManager.create(options.cwd);
  const result = await pi.createAgentSession({
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager,
    modelRuntime: state().modelRuntime ?? undefined,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
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
  const task = getTask(taskId);
  if (!task) throw new Error("タスクが見つかりません");
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
  });
  patchTask(taskId, {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    ...modelId(session.model),
  });
  return attachSession(taskId, session);
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

export async function getHealth(): Promise<HealthDto> {
  try {
    await ensureRuntime();
  } catch {
    /* initError is set */
  }
  const current = state();
  const models = current.modelRuntime ? await listModels().catch(() => []) : [];
  return {
    ok: !current.initError,
    engine: "pi",
    engineOk: !current.initError && models.length > 0,
    version: packageVersion(),
    modelCount: models.length,
    dataDir: dataDir(),
    error: current.initError,
  };
}

export async function listModels(): Promise<ModelOption[]> {
  await ensureRuntime();
  const runtime = state().modelRuntime;
  if (!runtime) return [];
  // Pick up the real GGUF id from a running llama-server (avoids stub "local").
  await syncLlamaServerProvider(runtime).catch(() => {});
  await syncOllamaCloudProvider(runtime).catch(() => {});
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
}

export async function saveProviderModelsOrder(input: {
  providerOrder?: string[];
  modelOrder?: Record<string, string[]>;
}): Promise<void> {
  await setProviderModelOrder(input);
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
}

export function getProjects(): ProjectDto[] {
  return listProjects();
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

export function getTaskSummaries(): TaskSummary[] {
  return listTasks().map(toSummary);
}

export async function getTaskDetail(id: string): Promise<TaskDetail> {
  const task = getTask(id);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  let messages: UiMessage[] = [];
  let isStreaming = false;
  let isCompacting = false;
  let contextUsage: ContextUsageDto | undefined;
  try {
    const live = await ensureLive(id);
    const fields = sessionSnapshotFields(live.session, live.throughputByStartedAt);
    messages = fields.messages;
    isStreaming = fields.isStreaming;
    isCompacting = fields.isCompacting;
    contextUsage = fields.contextUsage;
  } catch {
    messages = [];
  }
  return {
    ...toSummary(getTask(id) ?? task),
    messages,
    isStreaming,
    isCompacting,
    contextUsage,
  };
}

export async function createTask(input: {
  projectId: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  images?: PromptImage[];
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
  queuePrompt(live, input.prompt, input.images);
  return toSummary(getTask(task.id) ?? task);
}

function queuePrompt(live: LiveRuntime, prompt: string, images?: PromptImage[]): void {
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
      await live.session.prompt(prompt, options);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setTaskStatus(live.taskId, "error", message);
      emit(live.taskId, {
        type: "snapshot",
        task: toSummary(getTask(live.taskId)!),
        ...sessionSnapshotFields(live.session, live.throughputByStartedAt),
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
): Promise<TaskSummary> {
  const live = await ensureLive(id);
  queuePrompt(live, prompt, images);
  return toSummary(getTask(id)!);
}

export async function abortTask(id: string): Promise<TaskSummary> {
  const live = state().live.get(id);
  if (live) await live.session.abort();
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
  const thinkingLevel = isThinkingLevel(live.session.thinkingLevel)
    ? live.session.thinkingLevel
    : clampThinkingLevelForModel(model, getTask(id)?.thinkingLevel);
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
    ...sessionSnapshotFields(live.session, live.throughputByStartedAt),
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
    ...sessionSnapshotFields(live.session, live.throughputByStartedAt),
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
