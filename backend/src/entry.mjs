import { DEFAULT_BACKEND_PORT } from "../../shared/backend-protocol.mjs";
import { createPendingSnapshotStore } from "../core/pending-snapshot-store.mjs";
import { closeBackend, createBackendServer, listenBackend } from "./server.mjs";

/**
 * The runtime owner records into this store once a Pi runtime is attached. Until
 * then the read stays empty, which is honest: nothing has scheduled a snapshot in
 * this process yet. Readiness is deliberately not wired to the host here — health
 * must stay 503 until startup reconciliation has actually run.
 */
const pendingSnapshots = createPendingSnapshotStore({ limit: 512 });

try {
  const rawPort = process.env.LEAFCODE_PI_BACKEND_PORT;
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) {
    throw new Error("Invalid backend port");
  }
  const port = rawPort === undefined ? DEFAULT_BACKEND_PORT : Number(rawPort);
  const server = createBackendServer({
    token: process.env.LEAFCODE_PI_BACKEND_TOKEN,
    readPendingSnapshots: () => pendingSnapshots.list(),
  });
  const address = await listenBackend(server, port);
  // Transport is up, but health stays 503 until a Pi runtime is attached.
  console.log(JSON.stringify({ type: "backend_listening", address: address.address, port: address.port }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
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
