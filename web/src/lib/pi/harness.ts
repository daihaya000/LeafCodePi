import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  SUBSCRIPTION_PROVIDER_IDS,
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
import type {
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

function snapshotMessages(session: AgentSession): UiMessage[] {
  const stored: unknown[] = Array.isArray(session.messages) ? [...session.messages] : [];
  const streaming = session.agent.state.streamingMessage;
  if (streaming && stored[stored.length - 1] !== streaming) {
    stored.push(streaming);
  }
  return projectPiMessages(stored);
}

function emit(taskId: string, payload: { type: string; [key: string]: unknown }): void {
  state().events.emit(taskId, payload);
  state().events.emit("*", { taskId, ...payload });
}

function attachSession(taskId: string, session: AgentSession): LiveRuntime {
  const current = state();
  const existing = current.live.get(taskId);
  existing?.unsubscribe();

  const unsubscribe = session.subscribe((event) => {
    const task = getTask(taskId);
    if (!task) return;
    const ids = modelId(session.model);
    if (event.type === "agent_start") {
      setTaskStatus(taskId, "working");
    }
    if (event.type === "agent_settled" || (event.type === "agent_end" && !event.willRetry)) {
      const error = session.agent.state.errorMessage ?? null;
      setTaskStatus(taskId, error ? "error" : "idle", error);
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
      messages: snapshotMessages(session),
      isStreaming: session.isStreaming,
      eventType: event.type,
    });
  });

  const live: LiveRuntime = {
    taskId,
    session,
    unsubscribe,
    promptChain: Promise.resolve(),
  };
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
  return {
    ...task,
    status: live.session.isStreaming ? "working" : task.status,
    sessionId: live.session.sessionId ?? task.sessionId,
    sessionFile: live.session.sessionFile ?? task.sessionFile,
    providerID: ids.providerID ?? task.providerID,
    modelID: ids.modelID ?? task.modelID,
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
      highlighted: SUBSCRIPTION_PROVIDER_IDS.has(provider.id),
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
  try {
    const live = await ensureLive(id);
    messages = snapshotMessages(live.session);
    isStreaming = live.session.isStreaming;
  } catch {
    messages = [];
  }
  return { ...toSummary(getTask(id) ?? task), messages, isStreaming };
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
  const session = await createSession({
    cwd: project.rootPath,
    model,
    thinkingLevel: input.thinkingLevel,
  });
  patchTask(task.id, {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    status: "working",
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
        messages: snapshotMessages(live.session),
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
  const model = await resolveModel(modelValueRaw);
  if (!model) throw Object.assign(new Error("モデルが見つかりません"), { status: 400 });
  await live.session.setModel(model);
  const ids = modelId(model);
  const task = patchTask(id, ids);
  if (!task) throw Object.assign(new Error("タスクが見つかりません"), { status: 404 });
  return toSummary(task);
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
