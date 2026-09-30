import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";
import { createPendingSnapshotStore } from "../core/pending-snapshot-store.mjs";
import { createRuntimeHost } from "./runtime-host.mjs";
import { DEFAULT_RUNTIME_BUNDLE, loadBackendRuntime } from "./runtime-loader.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";
import { createBackendStartup } from "./startup.mjs";

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
  const server = createBackendServer({
    token: process.env.LEAFCODE_PI_BACKEND_TOKEN,
    readPendingSnapshots: () => pendingSnapshots.list(),
    // The Backend's own store view: stored rows, read through the same store the startup owns.
    readTasks: () => [...started.store.listTasks(true), ...started.store.listTasks(true, "bot")],
    readTask: (id) => started.store.getTask(id) ?? null,
    // Ready means the startup sequence finished *and* the runtime is attached. A detached runtime
    // (or a bundle that could not be loaded) keeps health at 503/starting.
    isReady: () => host.isReady() && started.runtimeStatus().ok === true,
  });
  const address = await listenBackend(server, port);
  // Transport is up, but health stays 503 until the startup sequence has attached the runtime.
  console.log(JSON.stringify({ type: "backend_listening", address: address.address, port: address.port }));
  if (runtimeRequested) {
    // Started in the background: the socket must be usable while the runtime attaches, and a failed
    // attach is reported through health, never through an exception message.
    void host.start().catch(() => {
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
