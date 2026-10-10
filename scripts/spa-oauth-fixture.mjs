// Test-only owner DTO/session transport. Never loads the SDK or contacts a provider.
export function createOAuthFixture({ origin, streams, streamPaths }) {
  const sessions = new Map(), sessionStreams = new Map();
  let enabled = false, sequence = 0;
  const providers = [
    { id: "openai-codex", name: "OpenAI Codex" }, { id: "anthropic", name: "Anthropic" },
  ].map(provider => ({ ...provider, authenticated: true, subscription: true, highlighted: true, oauthAvailable: true, methods: ["oauth"], accountRoutingMode: "integrated" }));
  const accounts = [
    { id: "codex-a", label: "Fixture Codex A", providers: ["openai-codex"] },
    { id: "codex-b", label: "Fixture Codex B", providers: ["openai-codex"] },
    { id: "claude-a", label: "Fixture Claude A", providers: ["anthropic"] },
  ].map(account => ({ ...account, enabled: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));
  const write = (stream, event, payload) => stream.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const emit = (id, event, payload) => {
    const session = sessions.get(id); if (!session) throw Error("Unknown fixture OAuth session");
    session.frames.push({ event, payload });
    for (const stream of sessionStreams.get(id) ?? []) write(stream, event, payload);
  };
  const done = (id, result) => {
    const session = sessions.get(id); session.finished = true;
    emit(id, "done", { type: "done", ...result });
  };
  const close = () => { for (const group of sessionStreams.values()) for (const stream of group) stream.end(); sessionStreams.clear(); };
  const auth = session => emit(session.id, "notify", { type: "notify", event: {
    type: "auth_url", url: origin() + "/fixture-oauth?provider=" + session.providerId,
    callbackUrl: "http://127.0.0.1:1456/auth/callback", instructions: "Fixture browser authorization",
  } });
  return {
    sessions, providers, accounts,
    enable: () => { close(); enabled = true; sessions.clear(); sequence = 0; },
    reset: () => { close(); enabled = false; sessions.clear(); sequence = 0; },
    emit, done,
    replayNotifications: id => { for (const stream of sessionStreams.get(id) ?? []) for (const frame of sessions.get(id).frames.filter(frame => frame.event === "notify")) write(stream, frame.event, frame.payload); },
    activeStreams: id => sessionStreams.get(id)?.size ?? 0,
    close,
    handle(item, url, response, json) {
      const path = url.pathname;
      if (enabled && path === "/api/providers") { json({ providers }); return true; }
      if (enabled && path === "/api/accounts") { json({ accounts }); return true; }
      const account = enabled && /^\/api\/accounts\/([^/]+)\/auth-status$/.exec(path);
      if (account) {
        const found = accounts.find(record => record.id === account[1]);
        json(found ? { providers: found.providers, credentialKinds: Object.fromEntries(found.providers.map(id => [id, "oauth"])) } : { error: "Unknown fixture account" }, found ? 200 : 404); return true;
      }
      const match = /^\/api\/providers\/([^/]+)\/login(?:\/(events|answer|callback))?$/.exec(path);
      if (!match) return false;
      const providerId = decodeURIComponent(match[1]), action = match[2];
      if (!action && item.method === "POST") {
        if (enabled && !providers.some(provider => provider.id === providerId)) { json({ error: "Unknown fixture provider" }, 404); return true; }
        const id = enabled ? `oauth-${++sequence}` : "fixture-login";
        const session = { id, providerId, accountId: url.searchParams.get("accountId"), frames: [], finished: false, cancelled: false, state: `fixture-state-${id}` };
        sessions.set(id, session);
        if (!enabled) emit(id, "notify", { type: "notify", event: { type: "auth_url", url: origin() + "/fixture-oauth", callbackUrl: origin() + "/fixture-callback", instructions: "Fixture OAuth callback" } });
        else if (providerId === "openai-codex") emit(id, "prompt", { type: "prompt", id: "method", prompt: { type: "select", message: "Fixture Codex login method", options: [{ id: "browser", label: "Fixture browser login" }, { id: "device", label: "Fixture device login" }] } });
        else {
          auth(session);
          emit(id, "prompt", { type: "prompt", id: "manual", prompt: { type: "manual_code", message: "Fixture native code", placeholder: "Fixture authorization code" } });
        }
        json({ sessionId: id }); return true;
      }
      const id = url.searchParams.get("sessionId") ?? item.body?.sessionId;
      const session = sessions.get(id);
      if (!session || session.providerId !== providerId) { json({ error: "Fixture OAuth session/provider mismatch" }, 400); return true; }
      if (action === "events" && item.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
        streams.add(response); streamPaths.set(response, path);
        if (!sessionStreams.has(id)) sessionStreams.set(id, new Set());
        const group = sessionStreams.get(id); group.add(response);
        response.on("close", () => { group.delete(response); streams.delete(response); streamPaths.delete(response); });
        for (const frame of session.frames) write(response, frame.event, frame.payload);
        return true;
      }
      if (action === "answer" && item.method === "DELETE") {
        session.cancelled = true;
        for (const stream of sessionStreams.get(id) ?? []) stream.end();
        json({ ok: true }); return true;
      }
      if (session.cancelled || session.finished) { json({ error: "Fixture OAuth session is inactive" }, 409); return true; }
      if (action === "answer" && item.method === "POST") {
        if (item.body?.promptId === "method") {
          if (item.body.value === "browser") auth(session);
          else if (item.body.value === "device") emit(id, "notify", { type: "notify", event: { type: "device_code", userCode: "FIXT-ABCD", verificationUri: origin() + "/fixture-device", intervalSeconds: 1, expiresInSeconds: 600 } });
          else { json({ error: "Invalid fixture login method" }, 400); return true; }
        } else if (item.body?.promptId === "manual" && providerId === "anthropic") {
          session.answer = item.body.value; // Deliberately dummy input; completion is separate SSE.
        } else { json({ error: "Invalid fixture login prompt" }, 400); return true; }
        json({ ok: true }); return true;
      }
      if (action === "callback" && item.method === "POST") {
        if (enabled) {
          let callback; try { callback = new URL(item.body.input); } catch { /* validation below */ }
          if (!callback || callback.origin !== "http://127.0.0.1:1456" || callback.pathname !== "/auth/callback" || callback.searchParams.get("state") !== session.state || !callback.searchParams.get("code")) {
            json({ error: "Fixture callback URL/state mismatch" }, 400); return true;
          }
          session.callback = item.body.input;
        } else done(id, { ok: true });
        json({ ok: true }); return true;
      }
      json({ error: "Unsupported fixture OAuth request" }, 405); return true;
    },
  };
}
