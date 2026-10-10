import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";
import { createBackendServer, listenBackend } from "./server.mjs";
const role = process.env.STREAM_PRODUCTION_ROLE;
let server, runtime, timer, producer, active = 0, emitted = 0;
if (role === "backend") {
  runtime = await import(pathToFileURL(process.env.STREAM_PRODUCTION_BUNDLE).href);
  server = createBackendServer({ token: process.env.LEAFCODE_PI_BACKEND_TOKEN, isReady: () => true, liveEventsAction: runtime.openLiveEvents, taskFileStreamAction: runtime.openTaskFileStream });
} else {
  const routesUrl = pathToFileURL(process.env.STREAM_GATEWAY_ROUTES);
  const { routes } = await import(routesUrl.href);
  const { createGatewayServer } = await import(new URL("./server.mjs", routesUrl).href);
  server = createGatewayServer(routes, { hostname: "127.0.0.1" });
  server.on("request", (_req, res) => { active++; res.once("close", () => active--); });
}
const addr = await listenBackend(server, 0);
const sample = () => ({ type: "sample", role, memory: process.memoryUsage(), spaces: getHeapSpaceStatistics().map(s=>({name:s.space_name,used:s.space_used_size})), state: runtime ? { live: runtime.readLiveEventDiagnostics(), file: runtime.readTaskFileStreamDiagnostics(), cold: runtime.readColdSnapshotDiagnostics(), sdkLoaded: Boolean(globalThis.__leafcodePiHarness?.pi), emitted, taskListeners: globalThis.__leafcodePiHarness?.events.listenerCount("task") ?? 0, botListeners: globalThis.__leafcodePiHarness?.events.listenerCount("bot:11111111-1111-4111-8111-111111111111") ?? 0 } : { active } });
timer = setInterval(() => process.send?.(sample()), 50); timer.unref();
process.on("message", m => {
  if (m === "sample") process.send?.(sample());
  if (m?.type === "producer") { clearInterval(producer); if (m.interval) producer = setInterval(() => { emitted++; for (const id of ["task", "bot:11111111-1111-4111-8111-111111111111"]) globalThis.__leafcodePiHarness?.events.emit(id, { type: "delta", message: { id: "live", role: "assistant", createdAt: 2, parts: [{ id: "text", type: "text", text: "日本語-" + emitted + "-" + "x".repeat(m.bytes ?? 16384) }] } }); }, m.interval); }
});
process.send?.({ ...sample(), type: "ready", port: addr.port });
process.on("disconnect", () => { clearInterval(timer); clearInterval(producer); server.closeAllConnections(); server.close(); });
