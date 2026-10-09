import { markMcpBusinessEffect } from "../core/mcp-business-effects.mjs";
import { dataDir } from "../core/app-paths.mjs";
import { runtimeGenerationStatus } from "../../shared/backend-generation.mjs";
import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";
import { readPendingRequestSnapshots } from "./pending-requests.mjs";
import { readMcpMigrationDiagnostics } from "./mcp-migration-diagnostics.mjs";
import { createNativeMcpStartup, legacyAuthWriteRefusal } from "./mcp-native-activation.mjs";
import { createBackendMcpHeaderNameStore } from "../core/mcp-header-names.mjs";
import { parseMcpBearerSaveRequest } from "../../shared/mcp-bearer-save-request.mjs";
import { parseMcpHeadersSaveRequest } from "../../shared/mcp-headers-save-request.mjs";
import { parseMcpAuthRemoveRequest } from "../../shared/mcp-auth-remove-request.mjs";
import { publicMcpAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";
import { publicMcpReload } from "../../shared/mcp-preset-request.mjs";
import { createRuntimeHost } from "./runtime-host.mjs";
import { readRuntimeControlState } from "./runtime-state.mjs";
import { createResumePrompt } from "./restart-resume-prompt.mjs";
import { DEFAULT_RUNTIME_BUNDLE, loadBackendRuntime } from "./runtime-loader.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
import { createBackendStartup } from "./startup.mjs";
import { acquireRuntimeOwner } from "../core/runtime-owner-lock.mjs";

/**
 * Clears a Bot's Code session link, stopping the session first when it is still running.
 *
 * Mirrors the WebUI's owning-mode ladder: an archived or missing task only clears matching links, a
 * task that is not a Bot-panel Code session is a miss, and a session that cannot be stopped is
 * refused instead of silently unlinking a running run.
 *
 * Returns the new task (always null, like the WebUI) or throws `{status}` for a refusal.
 */
async function clearBotCodeSessionLink(runtime, botId, taskId) {
  const linked = runtime.getTask(taskId);
  const bot = runtime.getBot(botId);
  // The endpoint wraps the answer as `{ task }`, and a cleared link has no task.
  const clearLinks = () => {
    if (linked?.supervisorBotId === botId) runtime.patchTask(taskId, { supervisorBotId: null });
    if (bot?.codeSessionTaskId === taskId) runtime.patchBot(botId, { codeSessionTaskId: null });
    return null;
  };
  if (!linked || linked.status === "archived") return clearLinks();
  const isBotPanelCodeTask =
    linked.kind !== "bot" &&
    (linked.botId === botId || linked.supervisorBotId === botId) &&
    !runtime.isRoomDelegatedCodeTask(taskId);
  if (!isBotPanelCodeTask) {
    throw Object.assign(new Error("Code session not found"), { status: 404 });
  }
  const loop = runtime.readGoalLoopState(linked.directory, linked.sessionId);
  if (linked.status === "working" || runtime.isGoalLoopSessionOwned(loop)) {
    try {
      await runtime.stopBotCodeTask(botId, taskId);
    } catch {
      await runtime.abortTaskIncludingColdGoalLoop(taskId).catch(() => {});
    }
    const after = runtime.getTask(taskId);
    const afterLoop = after ? runtime.readGoalLoopState(after.directory, after.sessionId) : null;
    if (after && (after.status === "working" || runtime.isGoalLoopSessionOwned(afterLoop))) {
      throw Object.assign(new Error("Code session could not be stopped"), { status: 409 });
    }
  }
  return clearLinks();
}

/** Values that ask the Backend to attach the runtime; anything else leaves it detached. */
const RUNTIME_ENABLED_VALUES = new Set(["1", "true", "yes", "attach"]);

export function isRuntimeRequested(env = process.env) {
  return RUNTIME_ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RUNTIME ?? "").trim().toLowerCase());
}

let releaseRuntimeOwner;
process.env.LEAFCODE_PI_PROCESS_ROLE = "backend";
try {
  const rawPort = process.env.LEAFCODE_PI_BACKEND_PORT;
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) {
    throw new Error("Invalid backend port");
  }
  const port = rawPort === undefined ? DEFAULT_BACKEND_PORT : Number(rawPort);
  const runtimeRequested = isRuntimeRequested();
  // Acquire before attaching or exposing this process as a runtime owner. Detached Backends do not
  // touch sessions, leases or stores and therefore do not claim the shared owner slot.
  if (runtimeRequested) releaseRuntimeOwner = acquireRuntimeOwner(dataDir());
  // Opt-in native MCP: only meaningful with an attached runtime, and never a fallback path. The
  // bundled adapter stays authoritative while the flag is unset, so the two never run together.
  const nativeMcp = createNativeMcpStartup({ runtimeRequested });
  // Header NAMES written through the native auth API (never values), so a "saved headers" removal
  // deletes exactly those instead of every header the user may have edited into mcp.json.
  const headerNames = nativeMcp ? createBackendMcpHeaderNameStore({ dataDir: dataDir() }) : null;
  /** Native auth mutation: writes the config header through the owner, then answers with the same
   * public snapshot/reload shape the legacy store bridge produced. Values never leave the owner. */
  const nativeAuthMutation = async (runtime, name, write) => {
    let before;
    try { before = nativeMcp.readAuthStatus(name); }
    catch { throw Object.assign(new Error("Backend MCP auth target not found"), { status: 404 }); }
    markMcpBusinessEffect();
    try { await write(); }
    catch { throw Object.assign(new Error("Backend MCP auth write failed"), { status: 409 }); }
    const auth = publicMcpAuthSnapshot(nativeMcp.readAuthStatus(name));
    const reload = publicMcpReload(await runtime.reloadLiveSessionsContext());
    if (!auth || !reload || auth.name !== before.name) throw Object.assign(new Error("Backend MCP auth result invalid"), { status: 500 });
    return { ok: true, auth, reload };
  };
  const started = createBackendStartup({
    // Only the host may attach the runtime: the Web process still owns the SDK unless it is asked
    // to hand over, and two owners would double-write the store, leases and sessions.
    ...(runtimeRequested
      ? {
          loadRuntime: () =>
            loadBackendRuntime({
              bundlePath: process.env.LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE?.trim() || DEFAULT_RUNTIME_BUNDLE,
            }),
          // Restart resume prompts a session, which only the attached runtime can do; the lookup is
          // late-bound because the attach runs before the reconciliation that offers orphaned tasks.
          promptTask: createResumePrompt({ getRuntime: () => started.runtime() }),
          // The provider must be installed inside the bundle's own module instance, so it is built
          // from the attached runtime module rather than imported here.
          ...(nativeMcp ? { initializeRuntime: nativeMcp.initializeRuntime } : {}),
        }
      : {}),
  });
  const host = createRuntimeHost({ startup: started.startup });
  // The Host pins the generation it started this Backend with; a mismatch means this process is not
  // the build the Host intended, so it must not become ready and must not be written to.
  const pinnedGeneration = process.env.LEAFCODE_PI_BACKEND_GENERATION;
  const generationStatus = () =>
    runtimeGenerationStatus(pinnedGeneration, started.runtimeStatus().generation ?? null);
  const server = createBackendServer({
    token: process.env.LEAFCODE_PI_BACKEND_TOKEN,
    readPendingSnapshots: () => readPendingRequestSnapshots(started.runtime()),
    // Read-only and useful even before runtime attachment; apply remains unavailable.
    readMcpMigrationDiagnostics: () => readMcpMigrationDiagnostics(),
    readMcpServerList: () => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      try { return runtime.readMcpServerList(); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP list failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    setMcpServerEnabledAction: async (name, enabled) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      try {
        const write = () => {
          const listed = runtime.setMcpServerEnabled(name, enabled);
          return { ok: true, name, enabled, servers: listed.servers };
        };
        // Native MCP runs the write in the owner's writer scope and republishes the snapshot for
        // later sessions; the adapter path keeps its own executor. A republish failure is surfaced.
        if (nativeMcp) markMcpBusinessEffect();
        const result = nativeMcp ? await nativeMcp.runConfigWrite(write) : write();
        // Persist and respond first; the owner alone rebuilds its live sessions.
        markMcpBusinessEffect();
        setImmediate(() => {
          void Promise.resolve().then(() => runtime.reloadLiveSessionsContext()).catch(() => {
            console.warn("[mcp] Backend live session context reload failed");
          });
        });
        return result;
      } catch (error) {
        throw Object.assign(new Error("Backend MCP setting update failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    completeMcpOAuthAuthAction: async (name, input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      if (nativeMcp) throw legacyAuthWriteRefusal();
      try { return await runtime.completeMcpOAuthAuth(name, input); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP OAuth completion failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    startMcpOAuthAuthAction: async (name, input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      if (nativeMcp) throw legacyAuthWriteRefusal();
      try { return await runtime.startMcpOAuthAuth(name, input); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP OAuth start failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    removeMcpAuthAction: async (name, input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      if (nativeMcp) {
        const parsed = parseMcpAuthRemoveRequest(input);
        if (!parsed.ok || !parsed.value.type) throw Object.assign(new Error("Backend MCP auth removal failed"), { status: 400 });
        const type = parsed.value.type;
        if (type === "oauth") return nativeAuthMutation(runtime, name, () => { nativeMcp.removeOAuth(name); });
        const recorded = type === "bearer" ? ["Authorization"] : headerNames.read(name);
        if (recorded.length === 0) return nativeAuthMutation(runtime, name, () => undefined);
        return nativeAuthMutation(runtime, name, async () => {
          await nativeMcp.writeAuth(name, Object.fromEntries(recorded.map((header) => [header, null])));
          headerNames.record(name, headerNames.read(name).filter((header) => !recorded.includes(header)));
        });
      }
      try { return await runtime.removeMcpAuth(name, input); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP auth removal failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    saveMcpHeadersAuthAction: async (name, input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      if (nativeMcp) {
        const parsed = parseMcpHeadersSaveRequest(input);
        if (!parsed.ok) throw Object.assign(new Error("Backend MCP headers save failed"), { status: 400 });
        const written = Object.keys(parsed.value.headers);
        return nativeAuthMutation(runtime, name, async () => {
          await nativeMcp.writeAuth(name, parsed.value.headers);
          headerNames.record(name, [...headerNames.read(name), ...written]);
        });
      }
      try { return await runtime.saveMcpHeadersAuth(name, input); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP headers save failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    saveMcpBearerAuthAction: async (name, input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      if (nativeMcp) {
        const parsed = parseMcpBearerSaveRequest(input);
        if (!parsed.ok) throw Object.assign(new Error("Backend MCP bearer save failed"), { status: 400 });
        return nativeAuthMutation(runtime, name, () => nativeMcp.writeAuth(name, { Authorization: `Bearer ${parsed.value.token}` }));
      }
      try { return await runtime.saveMcpBearerAuth(name, input); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP bearer save failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    readMcpAuthStatus: async (name) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      // Native MCP reads its own fixed credential store; the adapter's store would report the wrong state.
      if (nativeMcp) {
        try { return nativeMcp.readAuthStatus(name); }
        catch { throw Object.assign(new Error("Backend MCP auth status failed"), { status: 409 }); }
      }
      try { return await runtime.readMcpAuthStatus(name); }
      catch (error) {
        throw Object.assign(new Error("Backend MCP auth status failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    createMcpPresetAction: async (input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      try {
        // Adding a preset writes the same config file the native loader reads, so a native runtime
        // republishes through the owner writer scope before responding.
        if (nativeMcp) markMcpBusinessEffect();
        return nativeMcp ? await nativeMcp.runConfigWrite(() => runtime.createMcpPreset(input)) : await runtime.createMcpPreset(input);
      }
      catch (error) {
        throw Object.assign(new Error("Backend MCP preset creation failed"), { status: runtime.mcpErrorStatus(error) });
      }
    },
    // Attention is the owner's in-memory view; a detached Backend has none, which is honest.
    subscribeRuntimeEvents: (listener) => {
      const runtime = started.runtime();
      if (!runtime) throw new Error("runtime unavailable");
      const unsubscribeCode = runtime.subscribeBotCodeSession((payload) => listener({ event: "snapshot", payload }));
      let unsubscribeRoutine;
      let unsubscribeDirty;
      let unsubscribeStream = () => {};
      try {
        unsubscribeRoutine = runtime.subscribeRoutineRuns((payload) => listener({ event: "routine", payload }));
        unsubscribeDirty = runtime.subscribeTaskDirty((payload) => listener({ event: "task_dirty", payload }));
        // Optional: older bundles have no streaming wake, and their viewers keep the 2s stream poll.
        if (typeof runtime.subscribeTaskStream === "function") {
          unsubscribeStream = runtime.subscribeTaskStream((payload) => listener({ event: "task_stream", payload }));
        }
      } catch (error) {
        unsubscribeCode();
        unsubscribeRoutine?.();
        unsubscribeDirty?.();
        throw error;
      }
      return () => {
        unsubscribeCode();
        unsubscribeRoutine();
        unsubscribeDirty();
        unsubscribeStream();
      };
    },
    liveEventsAction: async (input) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.openLiveEvents !== "function") throw new Error("Event owner unavailable");
      return runtime.openLiveEvents(input);
    },
    taskFileStreamAction: async (input) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.openTaskFileStream !== "function") throw new Error("File owner unavailable");
      return runtime.openTaskFileStream(input);
    },
    providerLoginEventsAction: async (input) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.openProviderLoginEvents !== "function") throw new Error("Login event owner unavailable");
      return runtime.openProviderLoginEvents(input);
    },
    jsonBusinessRequestAction: async (input) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.dispatchJsonBusinessRequest !== "function") throw new Error("business owner unavailable");
      return runtime.dispatchJsonBusinessRequest(input);
    },
    configurationRequestAction: async (input) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.dispatchConfigurationRequest !== "function") throw new Error("configuration owner unavailable");
      const profileChange = input.route === "profile" && (["POST", "PUT", "DELETE"].includes(input.method)
        || (input.method === "PATCH" && JSON.parse(Buffer.from(input.body ?? []).toString("utf8") || "{}").action === "restore-packages"));
      return runtime.dispatchConfigurationRequest(input, profileChange ? async (write) => {
        if (runtime.prepareAutoUpdate().prepared !== true) return Response.json({ error: "実行中のセッションがあるため設定を置換できません" }, { status: 409 });
        try { return nativeMcp && input.method !== "PATCH" ? await nativeMcp.runConfigWrite(write) : await write(); }
        finally { runtime.releaseAutoUpdate(); }
      } : undefined);
    },
    runtimeControlAction: async ({ action, value }) => {
      const runtime = started.runtime();
      if (!runtime) throw new Error("runtime unavailable");
      switch (action) {
        case "prepare-auto-update": return runtime.prepareAutoUpdate();
        case "release-auto-update": runtime.releaseAutoUpdate(); return { released: true };
        case "read-compaction": return runtime.getCompactionSettings();
        case "set-compaction": return runtime.setCompactionEnabled(value);
        case "read-cache-warming": return runtime.getCacheWarmingMode();
        case "set-cache-warming": return runtime.setCacheWarmingMode(value);
        case "refresh-compaction": runtime.refreshCompactionSuggestions(); return null;
        case "code-permissions": await runtime.applyCodePermissionSettingsToLiveTasks(); return null;
        default: throw new Error("unknown runtime setting");
      }
    },
    readRuntimeState: (options) => readRuntimeControlState(started.runtime(), options),
    readAttention: () => {
      const runtime = started.runtime();
      return runtime && typeof runtime.listPendingAttention === "function"
        ? runtime.listPendingAttention()
        : [];
    },
    // The Backend's own store view: stored rows, read through the same store the startup owns.
    readTasks: () => [...started.store.listTasks(true), ...started.store.listTasks(true, "bot")],
    readTask: (id) => started.store.getTask(id) ?? null,
    createTask: (input) => {
      const runtime = started.runtime();
      if (!runtime) throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      return runtime.createTask(input);
    },
    // Detail needs the runtime, so the handler is only supplied once it is attached; the route
    // answers 503 until then instead of reporting a missing task.
    // The Bot store is owned by the startup, like the task store.
    readBots: () => started.bots.list(),
    readBot: (id) => started.bots.get(id),
    // Forwarded prompts start sessions in this process, which owns the runtime after the cutover.
    promptTask: (id, body) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.handleTaskPrompt(id, body);
    },
    // Stopping a session: a Bot-owned Code task must mark its outbox as user-stopped, like the Bot panel.
    abortTask: (id, botId) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return botId ? runtime.stopBotCodeTask(botId, id) : runtime.abortTaskIncludingColdGoalLoop(id);
    },
    // A Bot Code session is created and run here: the task row, its outbox entry and the session.
    createBotCodeSession: async (botId, input) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      if (input?.action === "continue") {
        return runtime.continueBotCodeTask(botId, input.taskId, input.prompt);
      }
      if (input?.action === "clear" || input?.action === "unlink") {
        return clearBotCodeSessionLink(runtime, botId, input.taskId);
      }
      return runtime.createBotCodeTask(botId, input);
    },
    // The Goal Loop runs inside this process, so pause/resume/stop/complete must be applied here.
    goalLoopAction: async (id, body) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      const action = body?.action;
      const botId = typeof body?.botId === "string" && body.botId ? body.botId : null;
      if (action === "stop" && botId) {
        await runtime.stopBotCodeTask(botId, id);
        return runtime.goalLoopState(id, { offline: true });
      }
      if (action === "start") {
        if (body?.botId !== undefined) {
          if (!botId || id !== `bot:${botId}`) {
            throw Object.assign(new Error("Bot task mismatch"), { status: 400 });
          }
          return runtime.startBotGoalLoop(botId, body);
        }
        return runtime.startGoalLoopWithSelection(id, body);
      }
      return runtime.goalLoopCommand(id, {
        action,
        ...(action === "resume" && body?.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
      });
    },
    // A running session must be told about a model/thinking/agent change by its owner, which also
    // writes the stored row the next session will start from.
    setTaskModelAction: (id, model) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.setTaskModel !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.setTaskModel(id, model);
    },
    setTaskThinkingLevelAction: (id, thinkingLevel) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.setTaskThinkingLevel !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.setTaskThinkingLevel(id, thinkingLevel);
    },
    setTaskAgentAction: (id, agent) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.setTaskAgent !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.setTaskAgent(id, agent);
    },
    // Compaction summarizes inside the session, so only the owner may run or stop it.
    compactTaskAction: (id, customInstructions) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.compactTask !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.compactTask(id, customInstructions);
    },
    abortCompactTaskAction: (id) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.abortTaskCompaction !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.abortTaskCompaction(id);
    },
    // Room settings and deletion stop turns and member sessions, so only the owner may run them. The
    // answer keeps its own status and body: the WebUI replays both unchanged.
    roomAdminPatch: (roomId, body) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.handleRoomPatch !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.handleRoomPatch(roomId, body);
    },
    roomAdminDelete: (roomId) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.handleRoomDelete !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.handleRoomDelete(roomId);
    },
    // Posting a Room turn routes bots and starts their sessions, so only the owner may run it. The
    // answer keeps its own status and body: the WebUI replays both unchanged.
    roomPrompt: (roomId, body) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.handleRoomPrompt !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.handleRoomPrompt(roomId, body);
    },
    // Rewinding a task's transcript edits its session tree and clears the owner's pending attention.
    revertTaskAction: (id, entryId) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.revertTask !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.revertTask(id, entryId);
    },
    // A settings change rebuilds the context of live sessions, which only the owner holds.
    reloadLiveSessionsAction: async ({ action, agentName }) => {
      const runtime = started.runtime();
      const run = action === "refresh-agent" ? runtime?.refreshLiveSessionsForAgentDefinition : runtime?.reloadLiveSessionsContext;
      if (typeof run !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return action === "refresh-agent" ? run(agentName) : await run();
    },
    // A Bot settings change reaches its live conversations and a deletion stops its Room turns, Code
    // sessions and tasks, which only the owner holds. The answer keeps its own status and body.
    botAdminAction: (id, action, body) => {
      const runtime = started.runtime();
      const run = action === "delete" ? runtime?.handleBotDelete : runtime?.handleBotPatch;
      if (typeof run !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return action === "delete" ? run(id) : run(id, body);
    },
    // Archiving, deleting or moving a project stops its sessions and Code work, which only the owner
    // holds. The answer keeps its own status and body: the WebUI replays both unchanged.
    teardownProjectAction: async (id, action, destinationPath) => {
      const runtime = started.runtime();
      const run = action === "archive" ? runtime?.archiveProjectAndStopTasks
        : action === "destroy" ? runtime?.destroyProject : runtime?.migrateProject;
      if (typeof run !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      try {
        const value = action === "migrate" ? await run(id, destinationPath) : await run(id);
        return { status: 200, body: action === "archive" ? { project: value } : value };
      } catch (error) {
        const status = typeof error?.status === "number" ? error.status : 500;
        return { status, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
    // Moving a task or handing it to / back from a Bot rewires the live session, which only the owner
    // holds. The answer keeps its own status and body: the WebUI replays both unchanged.
    taskAdminAction: async (id, request) => {
      const runtime = started.runtime();
      const run = request.action === "promote" ? runtime?.promoteTask
        : request.action === "fork" ? runtime?.forkTask
        : request.action === "handoff" ? runtime?.handoffTaskToBot : runtime?.releaseTaskFromBot;
      if (typeof run !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      try {
        if (request.action === "promote") return { status: 200, body: await run(id, request.destinationPath) };
        if (request.action === "fork") return { status: 200, body: await run(id, request.entryId) };
        if (request.action === "handoff") return { status: 200, body: { task: await run(request.botId, id) } };
        return { status: 200, body: { task: await run(id) } };
      } catch (error) {
        const status = typeof error?.status === "number" ? error.status : 500;
        return { status, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
    // Archiving or deleting stops and disposes the live session, which only the owner holds.
    teardownTaskAction: (id, mode) => {
      const runtime = started.runtime();
      const run = mode === "destroy" ? runtime?.destroyTask : runtime?.archiveTask;
      if (typeof run !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return run(id);
    },
    // Restoring the leaf after a rewind is the same kind of session edit.
    unrevertTaskAction: (id) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.unrevertTask !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.unrevertTask(id);
    },
    // Rewinding a Room conversation stops its turns, clears the owner's pending attention and
    // cancels its Code jobs: all owner work, so the WebUI forwards the request here.
    revertRoom: async (roomId, messageId) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.revertRoomConversation !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.revertRoomConversation(roomId, messageId);
    },
    // Rewinding a Bot conversation rewrites its session and stops the discarded Code jobs, which
    // only the owner may do: the WebUI forwards the request here and returns the same payload.
    revertBotTask: async (botId, entryId) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.revertTask !== "function" || typeof runtime.botTaskId !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      const result = await runtime.revertTask(runtime.botTaskId(botId), entryId);
      const cancelledCodeRequests = typeof runtime.cancelBotCodeRequests === "function"
        ? await runtime.cancelBotCodeRequests(botId)
        : 0;
      return { ...result, cancelledCodeRequests };
    },
    // Running a routine prompts a session, so only the runtime owner may start it.
    runBotRoutine: (botId, routineId) => {
      const runtime = started.runtime();
      if (!runtime || typeof runtime.runRoutine !== "function") {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.runRoutine(botId, routineId);
    },
    // Stopping a Bot Code request also updates the Bot's outbox, which this process owns.
    botCodeRequestAction: async (botId, body) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      const action = body?.action;
      const requestId = body?.requestId;
      if (action !== "abort" || typeof requestId !== "string") {
        throw Object.assign(new Error("unsupported action"), { status: 400 });
      }
      const stopped = await runtime.stopBotCodeRequest(botId, requestId);
      if (!stopped) return null;
      let task;
      try {
        if (stopped.codeTaskId) task = await runtime.abortTaskIncludingColdGoalLoop(stopped.codeTaskId);
      } finally {
        if (stopped.codeTaskId) await runtime.completeBotCodeRequest(requestId);
      }
      return { requestId, state: stopped.state, ...(task ? { task } : {}) };
    },
    // A pending approval or question lives in this process's memory: only the owner can answer it.
    respondToPermission: (id, requestId, approved) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.respondToPermissionPrompt(id, requestId, approved);
    },
    respondToQuestion: (id, requestId, answer) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.respondToQuestionPrompt(id, requestId, answer);
    },
    readTaskDetail: (id, options = {}) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return typeof runtime.getTaskDetailReadOnly === "function"
        ? runtime.getTaskDetailReadOnly(id, options)
        : runtime.getTaskDetail(id, { offline: true, includeMessages: options.includeMessages });
    },
    // Ready means the startup sequence finished *and* the runtime is attached *and* every required
    // startup step exists in this process. A missing service (Bot Code relay, routine scheduler,
    // room runtime reconciliation) must keep health at 503: a cutover onto a Backend that cannot run
    // them would leave those features dead in both processes.
    isReady: () =>
      host.isReady() &&
      started.runtimeStatus().ok === true &&
      generationStatus().matches &&
      started.unavailable().length === 0,
    // The generation of the attached runtime: the frontend compares it with its own build.
    runtimeGeneration: () => generationStatus().running,
    runtimeGenerationPinned: () => generationStatus().pinned,
    // Why this build is not a complete replacement yet, so the refusal is diagnosable.
    runtimeStartupIncomplete: () => started.unavailable(),
  });
  const address = await listenBackend(server, port);
  // Transport is up, but health stays 503 until the startup sequence has attached the runtime.
  console.log(JSON.stringify({ type: "backend_listening", address: address.address, port: address.port }));
  if (runtimeRequested) {
    // Started in the background: the socket must be usable while the runtime attaches, and a failed
    // attach is reported through health, never through an exception message.
    void host
      .start()
      .then(() => {
        // Pin the generation of the runtime this host owns: a restart must not swap it.
        host.setGeneration(started.runtimeStatus().generation ?? null);
      })
      .catch(() => {
        console.error("Backend runtime startup failed; health stays starting.");
      });
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    host.stop();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 5_000);
    deadline.unref();
    try {
      await closeBackend(server);
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      releaseRuntimeOwner?.();
      releaseRuntimeOwner = undefined;
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // A stray rejection from a provider/SDK callback must not take every running session down.
  // Log the error name only: messages may contain paths or credentials.
  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({ type: "backend_unhandled_rejection", name: reason instanceof Error ? reason.name : typeof reason }));
  });
  // Process state is unknown after an uncaught exception: stop gracefully (releasing the owner lock)
  // and exit non-zero so the Host restarts a clean Backend.
  process.on("uncaughtException", (error) => {
    console.error(JSON.stringify({ type: "backend_uncaught_exception", name: error instanceof Error ? error.name : typeof error }));
    process.exitCode = 1;
    void stop().finally(() => process.exit(1));
  });
} catch {
  releaseRuntimeOwner?.();
  // Do not log environment values or exception text containing secrets.
  console.error("Backend startup failed; check runtime ownership, token, port and port availability.");
  process.exitCode = 1;
}
