import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBackendServer, listenBackend } from "./server.mjs";
import { readProviderLoginTransportDiagnostics } from "./provider-login-events.mjs";
const role = process.env.PROVIDER_FIXTURE_ROLE;
let server, runtime, session, sid = "", active = 0, producer, emitted = 0, notify, loginSignal, run, promptId, answered;
if (role === "backend") {
  runtime = await import(pathToFileURL(process.env.PROVIDER_FIXTURE_BUNDLE).href);
  runtime.getActiveProviderLogin(); // Initialize the real harness without opening an SDK runtime.
  if (process.env.PROVIDER_FIXTURE_EMPTY !== "1") {
    session = new runtime.ProviderLoginSession("fixture", "oauth"); sid = session.id;
    globalThis.__leafcodePiHarness.loginSession = session;
    run = session.run({ login: async (_p, _t, io) => {
      notify = io.notify; loginSignal = io.signal;
      notify({ type: "auth_url", url: "https://example.test/login?redirect_uri=http://127.0.0.1:1456/oauth/callback&state=fixture-state" });
      const off = session.subscribe(event => { if (event.type === "prompt") { promptId = event.id; off(); } });
      answered = await io.prompt({ type: "manual_code", message: "fixture prompt" });
    } });
  }
  server = createBackendServer({ token: process.env.LEAFCODE_PI_BACKEND_TOKEN, isReady: () => true, providerLoginEventsAction: runtime.openProviderLoginEvents });
} else {
  const { relayProviderLoginEvents } = await import(pathToFileURL(process.env.PROVIDER_FIXTURE_BUNDLE).href);
  server = createServer(async (req, res) => {
    const c = new AbortController(), abort = () => c.abort(); res.once("close", abort); req.socket.once("end", abort); active++;
    try {
      const request = new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, signal: c.signal });
      const response = await relayProviderLoginEvents(request, "fixture"); res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal: c.signal }); else res.end();
    } catch { res.destroy(); } finally { active--; res.off("close", abort); req.socket.off("end", abort); c.abort(); }
  });
}
const address = await listenBackend(server, 0);
const sample = () => ({ type: "sample", role, memory: process.memoryUsage(), state: runtime ? { ...runtime.readProviderLoginStreamDiagnostics(), ...readProviderLoginTransportDiagnostics(), ...session?.readDiagnostics(), sid, emitted, loginAborted: loginSignal?.aborted ?? false, answered: answered !== undefined } : { active } });
const timer = setInterval(() => process.send?.(sample()), 25); timer.unref();
process.on("message", async message => {
  if (message?.type === "producer") { clearInterval(producer); if (message.interval) { producer = setInterval(() => { emitted++; notify?.({ type: "progress", message: "日本語-" + emitted + "-" + "x".repeat(message.bytes ?? 16384) }); }, message.interval); producer.unref(); } }
  if (message?.type === "complete") { clearInterval(producer); session.answer(promptId, "isolated-fixture-code"); await run; process.send?.(sample()); }
  if (message === "sample") process.send?.(sample());
});
process.send?.({ ...sample(), type: "ready", port: address.port });
process.on("disconnect", () => { clearInterval(timer); clearInterval(producer); session?.cancel(); server.closeAllConnections(); server.close(); });
