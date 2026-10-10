import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureSpaGeneration } from "../host/src/spa-build.js";
import { resolveSpaMirrorRoot } from "./spa-build-generation.mjs";
import { createDevelopmentGateway } from "../gateway/src/development.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
try {
  const generation = await ensureSpaGeneration({ mirrorRoot: resolveSpaMirrorRoot(), skipStale: !!process.argv[2], log: text => process.stderr.write(text + "\n") });
  if (process.argv[2] && resolve(process.argv[2]) !== generation.directory) throw Error("Development generation changed");
  const require = createRequire(join(ROOT, "web/package.json"));
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const { routes } = await import(pathToFileURL(join(generation.cwd, "dist/gateway/src/routes.mjs")).href);
  const port = Number(process.env.LEAFCODE_PI_PORT ?? process.env.PORT ?? "3010"), hostname = process.env.LEAFCODE_PI_BIND_HOST ?? process.env.LEAFCODE_PI_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw Error("Explicit development gateway port required");
  const dev = await createDevelopmentGateway(routes, { createViteServer: createServer, webRoot: join(ROOT, "web"), staticRoot: generation.staticRoot, hostname, port, configFile: join(ROOT, "web/vite.config.ts") });
  dev.server.listen(port, hostname, () => console.log(JSON.stringify({ type: "gateway_listening", port: dev.server.address().port, mode: "development" })));
  dev.server.once("error", () => { void dev.close().finally(() => { process.exitCode = 1; }); });
  let closing = false; const stop = () => { if (!closing) { closing = true; void dev.close(); } };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
} catch { console.error("Controlled development gateway unavailable; check the sealed generation and installed frontend dependencies"); process.exitCode = 1; }
