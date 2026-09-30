import { runtimeGenerationStatus } from "../../shared/backend-generation.mjs";
import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";
import { createPendingSnapshotStore } from "../core/pending-snapshot-store.mjs";
import { createRuntimeHost } from "./runtime-host.mjs";
import { DEFAULT_RUNTIME_BUNDLE, loadBackendRuntime } from "./runtime-loader.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
import { createBackendStartup } from "./startup.mjs";

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

/**
 * The runtime owner records into this store once a Pi runtime is attached. Until
 * then the read stays empty, which is honest: nothing has scheduled a snapshot in
 * this process yet.
 */
const pendingSnapshots = createPendingSnapshotStore({ limit: 512 });

/** Values that ask the Backend to attach the runtime; anything else leaves it detached. */
const RUNTIME_ENABLED_VALUES = new Set(["1", "true", "yes", "attach"]);

export function isRuntimeRequested(env = process.env) {
  return RUNTIME_ENABLED_VALUES.has((env.LEAFCODE_PI_BACKEND_RUNTIME ?? "").trim().toLowerCase());
}

try {
  const rawPort = process.env.LEAFCODE_PI_BACKEND_PORT;
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) {
    throw new Error("Invalid backend port");
  }
  const port = rawPort === undefined ? DEFAULT_BACKEND_PORT : Number(rawPort);
  const runtimeRequested = isRuntimeRequested();
  const started = createBackendStartup({
    // Only the host may attach the runtime: the Web process still owns the SDK unless it is asked
    // to hand over, and two owners would double-write the store, leases and sessions.
    ...(runtimeRequested
      ? {
          loadRuntime: () =>
            loadBackendRuntime({
              bundlePath: process.env.LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE?.trim() || DEFAULT_RUNTIME_BUNDLE,
            }),
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
    readPendingSnapshots: () => pendingSnapshots.list(),
    // The Backend's own store view: stored rows, read through the same store the startup owns.
    readTasks: () => [...started.store.listTasks(true), ...started.store.listTasks(true, "bot")],
    readTask: (id) => started.store.getTask(id) ?? null,
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
      const { prompt, images, ...options } = body ?? {};
      return runtime.promptTask(id, prompt, Array.isArray(images) && images.length > 0 ? images : undefined, options);
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
        return runtime.startGoalLoopWithSelection(id, body);
      }
      return runtime.goalLoopCommand(id, {
        action,
        ...(action === "resume" && body?.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
      });
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
    readTaskDetail: (id) => {
      const runtime = started.runtime();
      if (!runtime) {
        throw Object.assign(new Error("runtime unavailable"), { status: 503 });
      }
      return runtime.getTaskDetail(id, { offline: true });
    },
    // Ready means the startup sequence finished *and* the runtime is attached. A detached runtime
    // (or a bundle that could not be loaded) keeps health at 503/starting.
    isReady: () =>
      host.isReady() && started.runtimeStatus().ok === true && generationStatus().matches,
    // The generation of the attached runtime: the frontend compares it with its own build.
    runtimeGeneration: () => generationStatus().running,
    runtimeGenerationPinned: () => generationStatus().pinned,
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
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch {
  // Do not log environment values or exception text containing secrets.
  console.error("Backend startup failed; check token, port and port availability.");
  process.exitCode = 1;
}
