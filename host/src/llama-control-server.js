/**
 * Minimal localhost control plane for llama-server and WebUI/host restart.
 * Bound to 127.0.0.1 only; Host header must be loopback (DNS-rebinding guard).
 */
import http from "node:http";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** @param {string | undefined} hostHeader @param {number} port */
export function isLoopbackHostHeader(hostHeader, port) {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  const host = hostHeader.trim().toLowerCase();
  const allowed = new Set([
    "127.0.0.1",
    "localhost",
    "[::1]",
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(host);
}

async function readJsonBody(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {{
 *   controlPort: number,
 *   onLlamaServerStatus: () => Promise<object> | object,
 *   onLlamaServerStart: (config: object) => Promise<{ ok: boolean }>,
 *   onLlamaServerStop: () => Promise<unknown> | unknown,
 *   onRestartWebui?: () => Promise<unknown> | unknown,
 *   onRestartHost?: () => Promise<unknown> | unknown,
 *   onBrowserConfigRead?: () => { autoOpenBrowser: boolean },
 *   onBrowserConfigWrite?: (patch: { autoOpenBrowser: boolean }) => { autoOpenBrowser: boolean },
 *   onWebUiAuthRead?: () => object,
 *   onWebUiAuthWrite?: (patch: { token?: string, enabled?: boolean }) => Promise<object> | object,
 *   onTranslationStatus?: () => Promise<object> | object,
 *   onTranslationStart?: () => Promise<object> | object,
 *   onTranslationStop?: () => Promise<unknown> | unknown,
 *   onTranslationInstall?: () => Promise<object> | object,
 *   onTranslationTranslate?: (body: object) => Promise<object> | object,
 *   onTranslationOverride?: (body: object) => Promise<object> | object,
 *   onTranslationUnreviewed?: (limit: unknown) => Promise<object> | object,
 *   onTranslationReviewResults?: (body: object) => Promise<object> | object,
 *   onChatGptBridge?: (action: string, body: object, query: URLSearchParams) => Promise<object> | object,
 *   onChatGptAdvisor?: (action: string, body: object, query: URLSearchParams) => Promise<object> | object,
 * }} handlers
 */
export function createLlamaControlServer(handlers) {
  const controlPort = handlers.controlPort;

  return http.createServer((req, res) => {
    void (async () => {
      if (!isLoopbackHostHeader(req.headers?.host, controlPort)) {
        res.writeHead(403, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "host header is not loopback" }));
        return;
      }

      const method = req.method ?? "GET";
      let pathname = "/";
      try {
        pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        pathname = "/";
      }
      if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
      }

      if (method === "GET" && pathname === "/llama-server/status") {
        try {
          const result = await handlers.onLlamaServerStatus();
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(result ?? { ok: true }));
        } catch (err) {
          res.writeHead(502, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (method === "POST" && pathname === "/llama-server/start") {
        const body = await readJsonBody(req).catch(() => ({}));
        const config = body && typeof body === "object" && !Array.isArray(body)
          ? {
              effort:
                typeof body.effort === "string" && ["low", "medium", "xhigh"].includes(body.effort)
                  ? body.effort
                  : undefined,
              contextLength:
                typeof body.contextLength === "number" &&
                Number.isSafeInteger(body.contextLength) &&
                body.contextLength >= 4096 &&
                body.contextLength <= 1_000_000
                  ? body.contextLength
                  : undefined,
              parallel:
                typeof body.parallel === "number" &&
                Number.isSafeInteger(body.parallel) &&
                body.parallel >= 1 &&
                body.parallel <= 16
                  ? body.parallel
                  : undefined,
              llamaServerBin:
                typeof body.llamaServerBin === "string" && body.llamaServerBin !== ""
                  ? body.llamaServerBin
                  : undefined,
              modelDir:
                typeof body.modelDir === "string" && body.modelDir !== "" ? body.modelDir : undefined,
              modelFile:
                typeof body.modelFile === "string" && body.modelFile !== ""
                  ? body.modelFile
                  : undefined,
              llamaServerHost:
                body.llamaServerHost === "127.0.0.1" || body.llamaServerHost === "0.0.0.0"
                  ? body.llamaServerHost
                  : undefined,
            }
          : {};
        const result = await handlers.onLlamaServerStart(config);
        res.writeHead(result.ok ? 200 : 500, JSON_HEADERS);
        res.end(JSON.stringify(result));
        return;
      }

      if (method === "POST" && pathname === "/llama-server/stop") {
        res.writeHead(202, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, target: "llama-server", accepted: true }));
        setImmediate(() => {
          Promise.resolve()
            .then(() => handlers.onLlamaServerStop())
            .catch(() => {});
        });
        return;
      }

      if (method === "POST" && pathname === "/restart/webui") {
        if (typeof handlers.onRestartWebui !== "function") {
          res.writeHead(501, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "webui restart is not supported by this host" }));
          return;
        }
        res.writeHead(202, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, target: "webui", accepted: true }));
        setImmediate(() => {
          Promise.resolve()
            .then(() => handlers.onRestartWebui())
            .catch(() => {});
        });
        return;
      }

      if (method === "POST" && pathname === "/restart/host") {
        if (typeof handlers.onRestartHost !== "function") {
          res.writeHead(501, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "host restart is not supported by this host" }));
          return;
        }
        res.writeHead(202, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, target: "host", accepted: true }));
        setImmediate(() => {
          Promise.resolve()
            .then(() => handlers.onRestartHost())
            .catch(() => {});
        });
        return;
      }

      if (pathname === "/webui/auth") {
        if (typeof handlers.onWebUiAuthRead !== "function" || typeof handlers.onWebUiAuthWrite !== "function") {
          res.writeHead(501, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "WebUI auth config is not supported by this host" }));
          return;
        }
        if (method === "GET") {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(await handlers.onWebUiAuthRead()));
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req).catch(() => ({}));
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: "auth config must be an object" }));
            return;
          }
          const patch = {};
          if (Object.prototype.hasOwnProperty.call(body, "token")) {
            if (typeof body.token !== "string") {
              res.writeHead(400, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, error: "token must be a string" }));
              return;
            }
            patch.token = body.token;
          }
          if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
            if (typeof body.enabled !== "boolean") {
              res.writeHead(400, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, error: "enabled must be a boolean" }));
              return;
            }
            patch.enabled = body.enabled;
          }
          if (Object.keys(patch).length === 0) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: "token or enabled is required" }));
            return;
          }
          try {
            const saved = await handlers.onWebUiAuthWrite(patch);
            res.writeHead(202, JSON_HEADERS);
            res.end(JSON.stringify({ ok: true, accepted: true, ...saved }));
          } catch (err) {
            const status =
              typeof err === "object" && err && "status" in err &&
              typeof err.status === "number" && err.status >= 400 && err.status < 500
                ? err.status
                : 500;
            res.writeHead(status, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        res.writeHead(405, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
        return;
      }

      if (pathname === "/browser/config") {
        if (typeof handlers.onBrowserConfigRead !== "function") {
          res.writeHead(501, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "browser config is not supported by this host" }));
          return;
        }
        if (method === "GET") {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(handlers.onBrowserConfigRead()));
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req).catch(() => ({}));
          if (typeof body?.autoOpenBrowser !== "boolean") {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: "autoOpenBrowser must be a boolean" }));
            return;
          }
          const saved = handlers.onBrowserConfigWrite({ autoOpenBrowser: body.autoOpenBrowser });
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({ ok: true, ...saved }));
          return;
        }
        res.writeHead(405, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
        return;
      }

      if (pathname.startsWith("/chatgpt-bridge/")) {
        if (typeof handlers.onChatGptBridge !== "function") {
          res.writeHead(501, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "ChatGPT Bridge is not supported by this host" }));
          return;
        }
        const action = pathname.slice("/chatgpt-bridge/".length);
        if (!/^[a-z-]+$/.test(action)) {
          res.writeHead(404, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        if (method !== "GET" && method !== "POST") {
          res.writeHead(405, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          return;
        }
        if (method === "GET" && action !== "status") {
          res.writeHead(405, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "GET supports status only" }));
          return;
        }
        const body = method === "POST" ? await readJsonBody(req, 16_384).catch(() => ({})) : {};
        let query = new URLSearchParams();
        try {
          query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
        } catch {
          // use an empty query for malformed request URLs
        }
        try {
          const result = await handlers.onChatGptBridge(action, body, query);
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(result ?? { ok: true }));
        } catch (err) {
          const status =
            typeof err === "object" && err && "status" in err &&
            typeof err.status === "number" && err.status >= 400 && err.status < 500
              ? err.status
              : 502;
          res.writeHead(status, JSON_HEADERS);
          res.end(JSON.stringify({
            ok: false,
            error: typeof err === "object" && err && "code" in err && typeof err.code === "string" ? err.code : "bridge_request_failed",
            message: err instanceof Error ? err.message : "ChatGPT Bridge request failed",
          }));
        }
        return;
      }

      if (pathname.startsWith("/chatgpt-advisor/")) {
        if (typeof handlers.onChatGptAdvisor !== "function") {
          res.writeHead(501, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "ChatGPT Advisor is not supported by this host" }));
          return;
        }
        const action = pathname.slice("/chatgpt-advisor/".length);
        if (!/^[a-z-]+$/.test(action)) {
          res.writeHead(404, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "not found" }));
          return;
        }
        if (method !== "GET" && method !== "POST") {
          res.writeHead(405, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          return;
        }
        if (method === "GET" && action !== "status") {
          res.writeHead(405, JSON_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "GET supports status only" }));
          return;
        }
        const body = method === "POST" ? await readJsonBody(req, 16_384).catch(() => ({})) : {};
        let query = new URLSearchParams();
        try {
          query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
        } catch {
          // use an empty query for malformed request URLs
        }
        try {
          const result = await handlers.onChatGptAdvisor(action, body, query);
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(result ?? { ok: true }));
        } catch (err) {
          const status =
            typeof err === "object" && err && "status" in err &&
            typeof err.status === "number" && err.status >= 400 && err.status < 500
              ? err.status
              : 502;
          res.writeHead(status, JSON_HEADERS);
          res.end(JSON.stringify({
            ok: false,
            error: typeof err === "object" && err && "code" in err && typeof err.code === "string" ? err.code : "advisor_request_failed",
            message: err instanceof Error ? err.message : "ChatGPT Advisor request failed",
          }));
        }
        return;
      }

      if (pathname.startsWith("/translation/")) {
        const action = pathname.slice("/translation/".length);
        if (method === "GET" && action === "status" && handlers.onTranslationStatus) {
          try {
            const result = await handlers.onTranslationStatus();
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(502, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        if (method === "POST" && action === "start" && handlers.onTranslationStart) {
          try {
            const result = await handlers.onTranslationStart();
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(502, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        if (method === "POST" && action === "install" && handlers.onTranslationInstall) {
          try {
            const result = await handlers.onTranslationInstall();
            res.writeHead(202, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(502, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        if (method === "POST" && action === "stop" && handlers.onTranslationStop) {
          res.writeHead(202, JSON_HEADERS);
          res.end(JSON.stringify({ ok: true, target: "translation", accepted: true }));
          setImmediate(() => {
            Promise.resolve()
              .then(() => handlers.onTranslationStop())
              .catch(() => {});
          });
          return;
        }
        if (method === "POST" && action === "translate" && handlers.onTranslationTranslate) {
          const body = await readJsonBody(req, 65_536).catch(() => ({}));
          try {
            const result = await handlers.onTranslationTranslate(body);
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(502, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        if (method === "POST" && action === "override" && handlers.onTranslationOverride) {
          const body = await readJsonBody(req).catch(() => ({}));
          try {
            const result = await handlers.onTranslationOverride(body);
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        if (method === "GET" && action === "unreviewed" && handlers.onTranslationUnreviewed) {
          let limit;
          try {
            limit = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("limit");
          } catch {
            limit = null;
          }
          try {
            const result = await handlers.onTranslationUnreviewed(limit);
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(502, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
        if (method === "POST" && action === "review-results" && handlers.onTranslationReviewResults) {
          const body = await readJsonBody(req, 262_144).catch(() => ({}));
          try {
            const result = await handlers.onTranslationReviewResults(body);
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (err) {
            res.writeHead(502, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }
      }

      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    })().catch((err) => {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
  });
}

/** @param {import("node:http").Server} server @param {number} port */
export function listenControlServer(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** @param {import("node:http").Server | null} server */
export function closeControlServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
