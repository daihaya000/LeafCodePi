// Test-only isolated process: runs the real Backend transport or the bundled Next relay.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createBackendServer, listenBackend } from "./server.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFileSync } from "node:fs";
const role = process.env.FILE_FIXTURE_ROLE;
let server, runtime, active = 0;
if (role === "backend") {
  if (process.env.FILE_FIXTURE_PREVIEW) {
    const bytes = readFileSync(process.env.FILE_FIXTURE_PREVIEW), id = "a".repeat(32);
    globalThis.__leafcodeLinkPreviews = { pages: new Map(), pending: new Map(), images: new Map([[id,{url:"https://fixture.invalid/image",expires:Date.now()+600000,data:{bytes,mime:"image/png"}}]]), activeImages:0, cachedImageBytes:bytes.length, imageReaders:0 };
  }
  runtime = await import(pathToFileURL(process.env.FILE_FIXTURE_BUNDLE).href);
  server = createBackendServer({ token: process.env.LEAFCODE_PI_BACKEND_TOKEN, isReady: () => true, taskFileStreamAction: runtime.openTaskFileStream });
} else {
  const { relayTaskFileStream } = await import(pathToFileURL(process.env.FILE_FIXTURE_BUNDLE).href);
  server = createServer(async (req, res) => {
    const controller = new AbortController(), abort = () => controller.abort();
    res.once("close", abort); req.socket.once("end", abort); active++;
    try {
      const request = new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, signal: controller.signal, ...(["GET","HEAD"].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: "half" }) });
      const route = new URL(request.url).pathname.replace(/^\/api\//, "");
      const source = await relayTaskFileStream(request, route);
      res.writeHead(source.status, Object.fromEntries(source.headers));
      if (source.body && req.method !== "HEAD") await pipeline(Readable.fromWeb(source.body), res, { signal: controller.signal });
      else res.end();
    } catch { res.destroy(); }
    finally { active--; res.off("close", abort); req.socket.off("end", abort); controller.abort(); }
  });
}
const address = await listenBackend(server, 0);
const snapshot = () => ({ type: "sample", role, memory: process.memoryUsage(), state: runtime ? runtime.readTaskFileStreamDiagnostics() : { active } });
const sampling = setInterval(() => process.send?.(snapshot()), 25); sampling.unref();
process.on("message", message => { if (message === "sample") process.send?.(snapshot()); });
process.send?.({ ...snapshot(), type: "ready", port: address.port });
process.on("disconnect", () => { clearInterval(sampling); server.closeAllConnections(); server.close(); });
