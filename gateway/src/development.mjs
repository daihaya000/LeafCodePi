import { createServer } from "node:http";
import { isIP } from "node:net";
import { readFileSync, realpathSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { webAuthGate } from "./auth.mjs";
import { createDispatcher } from "./router.mjs";
import { nodeHttpHandler, requestUrl } from "./http-adapter.mjs";
import { createStaticHandler } from "./static.mjs";
const HMR = "/__vite_hmr";
const screens = /^(?:\/|\/settings|\/task\/[^/]+|\/bots|\/bots\/[^/]+|\/bots\/rooms\/[^/]+)$/;
const types = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".svg", ".png", ".webp", ".jpg", ".jpeg", ".ico", ".woff", ".woff2"]);
const inside = (root, file) => { const path = relative(root, file); return path === "" || !path.startsWith("..") && !path.includes(":") && !path.startsWith("/") && !path.startsWith("\\"); };
function unsafe(raw) {
  if (/\\|%(?:2f|5c|25)|[\x00-\x1f]/i.test(raw)) return true;
  try { return decodeURIComponent(raw).split("/").some(part => part === "." || part === ".." || part.startsWith(".") && part !== ".vite"); } catch { return true; }
}
export function sameDevOrigin(request, { websocket = false } = {}) {
  const url = new URL(request.url), origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  return (!websocket || !!origin) && (!origin || origin === url.origin) && (!site || site === "same-origin" || site === "none");
}
export function devResourceAllowed(raw, webRoot, viteClientRoot) {
  if (unsafe(raw)) return false;
  const path = decodeURIComponent(raw);
  if (path === "/@vite/client" || path === "/@vite/env") return true;
  if (path.startsWith("/@id/")) return !/node:|@earendil|next\/|backend|extensions/.test(path);
  const root = realpathSync(webRoot), shared = realpathSync(resolve(root, "../shared"));
  let file;
  try { file = realpathSync(path.startsWith("/@fs/") ? path.slice(5) : resolve(root, "." + path)); } catch { return false; }
  if (viteClientRoot && file === realpathSync(resolve(viteClientRoot, "env.mjs"))) return true;
  const normalized = file.replaceAll("\\", "/");
  if (!inside(root, file) && !inside(shared, file) || !types.has(extname(file).toLowerCase())) return false;
  return !/\/(?:backend|host|extensions)\/|\/src\/app\/api\/|\/src\/lib\/pi\/|\/node_modules\/(?:next\/|@earendil|better-sqlite3|jiti\/)/.test(normalized);
}
function error(response, status, text) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify({ error: text })); }
function allowedAuthority(url, hostname, port) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = /^(?:127(?:\.\d{1,3}){3}|localhost|::1)$/.test(host);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port && (host === hostname || loopback || ["0.0.0.0", "::"].includes(hostname) && !!isIP(host));
}
function browserRequest(incoming) { return new Request(requestUrl(incoming), { headers: incoming.headers }); }
function upgradeError(socket, status) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }

/** Vite has no public or private listening port. Only this gateway admits HTTP and HMR upgrades. */
export async function createDevelopmentGateway(routes, { createViteServer, webRoot, staticRoot, hostname, port, configFile, dependencyRoot = resolve(webRoot, "node_modules"), scratchRoot = resolve(staticRoot, "../../.."), logLevel = "warn" } = {}) {
  process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
  const pinned = await createStaticHandler(staticRoot), privateHmr = createServer(), sockets = new Set();
  const viteClientRoot = resolve(dependencyRoot, "vite/dist/client");
  let vite;
  const normal = nodeHttpHandler(createDispatcher(routes, { staticHandler: pinned }), incoming => ({ hostname: hostname ?? server.address().address, port: incoming.socket.localPort, forwarded: true }));
  const server = createServer(async (incoming, response) => {
    try {
      const raw = (incoming.url ?? "").split("?")[0], request = browserRequest(incoming), url = new URL(request.url);
      if (!allowedAuthority(url, hostname, port) || !sameDevOrigin(request)) return error(response, 403, "Development authority forbidden");
      if (/^\/api(?:\/|$)/.test(raw) || url.pathname === "/webui-bootstrap.json" || url.pathname === "/login" || !/^\/(?:src\/|node_modules\/|@)/.test(raw) && pinned.isPublicAsset(url.pathname)) return normal(incoming, response);
      if (unsafe(raw) || !sameDevOrigin(request)) return error(response, 403, "Development request forbidden");
      if (!["GET", "HEAD"].includes(incoming.method)) return error(response, 405, "Method Not Allowed");
      const auth = webAuthGate(request);
      if (auth.response) {
        if (!screens.test(url.pathname)) return error(response, 401, "Unauthorized");
        response.writeHead(auth.response.status, Object.fromEntries(auth.response.headers)); return response.end();
      }
      if (url.searchParams.has("raw") || url.searchParams.has("url") || url.searchParams.has("worker")) return error(response, 403, "Development source mode forbidden");
      const setHeader = response.setHeader.bind(response);
      response.setHeader = (name, value) => setHeader(name, name.toLowerCase() === "cache-control" ? "private, no-store" : name.toLowerCase() === "x-content-type-options" ? "nosniff" : value);
      response.setHeader("cache-control", "private, no-store"); response.setHeader("x-content-type-options", "nosniff");
      if (auth.cookieHeader) response.setHeader("set-cookie", auth.cookieHeader);
      if (screens.test(url.pathname)) {
        const html = await vite.transformIndexHtml(url.pathname, readFileSync(resolve(webRoot, "index.html"), "utf8"));
        response.setHeader("content-type", "text/html; charset=utf-8"); response.end(incoming.method === "HEAD" ? undefined : html); return;
      }
      if (!devResourceAllowed(raw, webRoot, viteClientRoot)) return error(response, 404, "Not Found");
      vite.middlewares(incoming, response, () => error(response, 404, "Not Found"));
    } catch { if (!response.headersSent) error(response, 500, "Development ingress unavailable"); else response.destroy(); }
  });
  server.on("upgrade", (incoming, socket, head) => {
    try {
      const request = browserRequest(incoming), url = new URL(request.url);
      if (!allowedAuthority(url, hostname, port) || unsafe((incoming.url ?? "").split("?")[0]) || url.pathname !== HMR || !sameDevOrigin(request, { websocket: true }) || incoming.headers["sec-websocket-protocol"] !== "vite-hmr") return upgradeError(socket, 403);
      // Vite's public WS nonce is not a WebUI query password. Cookie/Bearer admission remains mandatory.
      url.search = ""; const auth = webAuthGate(new Request(url, { headers: request.headers }));
      if (auth.response) return upgradeError(socket, 401);
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      privateHmr.emit("upgrade", incoming, socket, head);
    } catch { upgradeError(socket, 400); }
  });
  server.on("clientError", (_error, socket) => upgradeError(socket, 400));
  try {
    vite = await createViteServer({ configFile, root: webRoot, appType: "custom", cacheDir: resolve(scratchRoot, ".dev-cache"), envDir: resolve(scratchRoot, "empty-dev-env"), envPrefix: [], logLevel,
      server: { middlewareMode: true, cors: false, proxy: {}, allowedHosts: true, fs: { strict: true, allow: [webRoot, resolve(webRoot, "../shared"), viteClientRoot], deny: ["**/.env*", "**/.git/**", "**/*.pem", "**/*.key"] }, hmr: { server: privateHmr, path: HMR, clientPort: port }, warmup: { clientFiles: [], ssrFiles: [] } } });
    if (privateHmr.listening || vite.httpServer?.listening) throw Error("Uncontrolled Vite listener");
  } catch (error) { await vite?.close(); server.close(); throw error; }
  return { server, vite, privateHmr, async close() { for (const socket of sockets) socket.destroy(); await vite.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } };
}
