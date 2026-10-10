import { createServer } from "node:http";
import { readWebUiPresentation } from "../shared/webui-presentation.mjs";
export const settings = { "composer-defaults": JSON.stringify({ model: "auto", autoOptimize: "cost", agent: "default", thinkingLevel: "high" }), "task-pane-prefer-new": "0" };
const at = "2026-01-01T00:00:00.000Z";
export const tasks = ["task-a", "task-b"].map((id, i) => ({ id, kind: "code", projectId: null, projectName: "", title: `Fixture task ${i + 1}`, directory: "/fixture", isolation: "current_folder", status: "idle", sessionId: id, sessionFile: null, createdAt: at, updatedAt: at }));
export const bot = { id: "bot-a", name: "Fixture Bot", label: "Fixture", soul: "", avatarColor: "#0071E3", avatarImage: null, model: null, thinkingLevel: "off", permissionMode: null, skills: { mode: "inherit", include: [], exclude: [] }, tools: [], extraRoots: [], enabled: true, notificationsEnabled: false, codeAutoApprove: false, createdAt: at, updatedAt: at };
export const room = { id: "room-a", name: "Fixture Room", members: [bot.id], botRelayEnabled: false, codeAutoApprove: false, messages: [], createdAt: at, updatedAt: at };
export async function startFixture({ dataDir } = {}) {
  const presentation = readWebUiPresentation(dataDir);
  const log = [], streams = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture"), path = url.pathname;
    let raw = ""; for await (const chunk of request) raw += chunk;
    const item = { path, query: url.search, method: request.method, body: raw ? JSON.parse(raw) : null }; log.push(item);
    const json = (body, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    if (path.endsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); streams.add(response);
      response.on("close", () => streams.delete(response));
      if (path.includes("/login/events")) {
        const origin = `http://${request.headers.host}`;
        response.write(`event: notify\ndata: ${JSON.stringify({ type: "notify", event: { type: "auth_url", url: origin + "/fixture-oauth", callbackUrl: origin + "/fixture-callback", instructions: "Fixture OAuth callback" } })}\n\n`);
      } else {
        const task = tasks.find(task => path === `/api/tasks/${task.id}/events`);
        const body = task ? { task, messages: [], isStreaming: false, todos: [], eventType: "snapshot", messageHistory: { hasMore: false, nextCursor: null } }
          : path === "/api/bots/bot-a/events" ? { bot, task: { ...tasks[0], id: "bot:bot-a", kind: "bot", botId: bot.id }, messages: [], isStreaming: false, routines: [] }
          : path === "/api/bots/rooms/room-a/events" ? { room, bots: [bot], attention: [] } : { bots: [bot], rooms: [room] };
        response.write(`event: snapshot\ndata: ${JSON.stringify(body)}\n\n`);
      }
      return;
    }
    if (path === "/webui-bootstrap.json") return json(presentation);
    if (path === "/api/settings") return json({ values: settings });
    if (path === "/api/peer-auth/peers") return json({ enabled: false, authRequired: false, grants: [] });
    if (path === "/api/llama-server/status") return json({ running: false, pid: null, listeningPids: [], health: null });
    if (path === "/api/llama-server/models") return json({ models: [], mmprojs: [], loras: [] });
    if (path === "/api/settings/llama-server-config") return json({ error: "Fixture local inference unavailable" }, 503);
    if (path === "/api/auth/webui") return json({ ok: true });
    if (path.includes("/login/callback")) {
      for (const stream of streams) stream.write('event: done\ndata: {"type":"done","ok":true}\n\n');
      return json({ ok: true });
    }
    if (path.endsWith("/login")) return json({ sessionId: "fixture-login" });
    if (path === "/api/health") return json({ ok: true, engine: "pi", engineOk: true, version: "fixture", modelCount: 1, dataDir: "/fixture", platform: "linux", startedAt: 1 });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/tasks") return json({ tasks });
    if (tasks.some(task => path === `/api/tasks/${task.id}`)) return json({ ...tasks.find(task => path === `/api/tasks/${task.id}`), messages: [], isStreaming: false, todos: [] });
    if (path === "/api/bots") return json({ bots: [bot] });
    if (path === "/api/bots/rooms") return json({ rooms: [room] });
    if (path === "/api/bots/bot-a") return json({ bot });
    if (path === "/api/bots/rooms/room-a") return json({ room });
    if (path === "/api/providers") return json({ providers: [{ id: "meta", name: "Fixture OAuth", authenticated: false, highlighted: true, oauthAvailable: true, accountRoutingMode: "integrated", methods: ["oauth"] }] });
    if (path === "/api/models") return json({ models: [{ id: "fixture-model", name: "Fixture Model", providerID: "fixture", contextWindow: 100000 }] });
    if (path === "/api/accounts") return json({ accounts: [] });
    if (path.includes("/code-requests")) return json({ requests: [] });
    if (path.includes("/routines")) return json({ routines: [] });
    if (path.includes("/usage")) return json({ providers: [], byBot: [], total: { tokens: 0, cost: 0 } });
    if (path.includes("/intercom")) return json({ messages: [], peers: [], asks: [], pending: [], scopes: [] });
    if (path === "/api/build-info") return json({ commit: null, latestCommit: null });
    if (path === "/api/host-probe") return json({ id: "fixture-process" });
    if (path === "/api/settings/tts") return json({ enabled: false, voice: "", rate: 10, url: "", sapiAvailable: false });
    if (path === "/api/settings/tts/voices") return json({ voices: [], backend: "none" });
    if (path.startsWith("/api/settings/")) return json({ value: settings[path.split("/").at(-1)] ?? null, enabled: false });
    if (path.includes("/permissions")) return json({ permissionMode: "ask", skillPermission: "allow", subagentPermission: "allow" });
    if (path === "/api/host/activity") return json({ ok: true });
    return json({ error: "Fixture owner unavailable" }, 503);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, presentation, log, streams,
    close: async () => { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
