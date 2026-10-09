import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";
import { createRequire } from "node:module";
import { createBackendServer, listenBackend } from "./server.mjs";
const role = process.env.STREAM_PRODUCTION_ROLE;
let server, runtime, timer, producer, nextFactory, handle, active = 0, emitted = 0;
if (role === "backend") {
  runtime = await import(pathToFileURL(process.env.STREAM_PRODUCTION_BUNDLE).href);
  server = createBackendServer({ token: process.env.LEAFCODE_PI_BACKEND_TOKEN, isReady: () => true, liveEventsAction: runtime.openLiveEvents, taskFileStreamAction: runtime.openTaskFileStream });
} else {
  const require = createRequire(process.env.STREAM_NEXT_PACKAGE); nextFactory = require("next");
  server = createServer((req, res) => { active++; res.once("close", () => active--); void handle(req, res); });
}
const addr = await listenBackend(server, 0);
if (nextFactory) {
  // Next constructs Request.url from the custom server hostname/port. Its
  // default 3000 is NOT the ephemeral listening port and breaks Origin checks.
  const app = nextFactory({ dev: false, dir: process.env.STREAM_NEXT_APP, hostname: "127.0.0.1", port: addr.port });
  await app.prepare(); handle = app.getRequestHandler();
}
const sample = () => ({ type: "sample", role, memory: process.memoryUsage(), spaces: getHeapSpaceStatistics().map(s=>({name:s.space_name,used:s.space_used_size})), state: runtime ? { live: runtime.readLiveEventDiagnostics(), file: runtime.readTaskFileStreamDiagnostics(), cold: runtime.readColdSnapshotDiagnostics(), sdkLoaded: Boolean(globalThis.__leafcodePiHarness?.pi), emitted, taskListeners: globalThis.__leafcodePiHarness?.events.listenerCount("task") ?? 0, botListeners: globalThis.__leafcodePiHarness?.events.listenerCount("bot:11111111-1111-4111-8111-111111111111") ?? 0 } : { active } });
timer = setInterval(() => process.send?.(sample()), 50); timer.unref();
process.on("message", m => {
  if (m === "sample") process.send?.(sample());
  if (m?.type === "producer") { clearInterval(producer); if (m.interval) producer = setInterval(() => { emitted++; for (const id of ["task", "bot:11111111-1111-4111-8111-111111111111"]) globalThis.__leafcodePiHarness?.events.emit(id, { type: "delta", message: { id: "live", role: "assistant", createdAt: 2, parts: [{ id: "text", type: "text", text: "日本語-" + emitted + "-" + "x".repeat(m.bytes ?? 16384) }] } }); }, m.interval); }
});
process.send?.({ ...sample(), type: "ready", port: addr.port });
process.on("disconnect", () => { clearInterval(timer); clearInterval(producer); server.closeAllConnections(); server.close(); });
