import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./spa-browser-fixture.mjs";

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function run(action) { const fixture = await startFixture(); fixture.oauth.enable(); try { await action(fixture); } finally { await fixture.close(); } }
const json = async (fixture, path, options) => (await fetch(fixture.origin + path, options)).json();
const begin = (fixture, provider, account) => json(fixture, `/api/providers/${provider}/login?accountId=${account}`, post({ type: "oauth" }));
const url = (provider, action) => `/api/providers/${provider}/login/${action}`;
async function open(fixture, path) {
  const abort = new AbortController(), response = await fetch(fixture.origin + path, { signal: abort.signal });
  const reader = response.body.getReader();
  return { abort: () => abort.abort(), read: async () => new TextDecoder().decode((await reader.read()).value) };
}

test("provider OAuth fixture creates unique, account-scoped sessions and native DTOs", () => run(async fixture => {
  const a = await begin(fixture, "openai-codex", "codex-a"), b = await begin(fixture, "openai-codex", "codex-b");
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(fixture.oauth.sessions.get(a.sessionId).accountId, "codex-a");
  assert.equal(fixture.oauth.sessions.get(b.sessionId).accountId, "codex-b");
  assert.equal((await json(fixture, "/api/accounts")).accounts.length, 3);
  assert.equal((await json(fixture, "/api/providers")).providers.length, 2);
  const mismatch = await fetch(fixture.origin + url("anthropic", "answer"), post({ sessionId: a.sessionId, promptId: "method", value: "browser" }));
  assert.equal(mismatch.status, 400);
}));

test("Codex relay rejects invalid URL/state and separates callback HTTP from SSE completion", () => run(async fixture => {
  const { sessionId } = await begin(fixture, "openai-codex", "codex-a");
  await json(fixture, url("openai-codex", "answer"), post({ sessionId, promptId: "method", value: "browser" }));
  const session = fixture.oauth.sessions.get(sessionId);
  assert.equal(session.frames.at(-1).payload.event.type, "auth_url");
  for (const input of ["invalid", "http://127.0.0.1:1456/wrong?code=x&state=" + session.state, "http://127.0.0.1:1456/auth/callback?code=x&state=wrong"]) {
    assert.equal((await fetch(fixture.origin + url("openai-codex", "callback"), post({ sessionId, input }))).status, 400);
  }
  const input = `http://127.0.0.1:1456/auth/callback?code=fixture-code&state=${session.state}`;
  assert.deepEqual(await json(fixture, url("openai-codex", "callback"), post({ sessionId, input })), { ok: true });
  assert.equal(session.callback, input); assert.equal(session.finished, false);
  fixture.oauth.done(sessionId, { ok: true });
  assert.equal(session.finished, true);
  assert.equal((await fetch(fixture.origin + url("openai-codex", "callback"), post({ sessionId, input }))).status, 409);
}));

test("native Anthropic input and Codex device selection use answer DTOs rather than relay callbacks", () => run(async fixture => {
  const { sessionId } = await begin(fixture, "anthropic", "claude-a");
  const input = "fixture-native-code#fixture-native-state";
  await json(fixture, url("anthropic", "answer"), post({ sessionId, promptId: "manual", value: input }));
  assert.equal(fixture.oauth.sessions.get(sessionId).answer, input);
  assert.equal(fixture.oauth.sessions.get(sessionId).finished, false);
  const device = await begin(fixture, "openai-codex", "codex-b");
  await json(fixture, url("openai-codex", "answer"), post({ sessionId: device.sessionId, promptId: "method", value: "device" }));
  assert.equal(fixture.oauth.sessions.get(device.sessionId).frames.at(-1).payload.event.type, "device_code");
  await json(fixture, url("openai-codex", "answer") + `?sessionId=${device.sessionId}`, { method: "DELETE" });
  assert.equal(fixture.oauth.sessions.get(device.sessionId).cancelled, true);
}));

test("OAuth done is isolated by session and cannot contaminate another login or shared Bot SSE", () => run(async fixture => {
  const a = await begin(fixture, "openai-codex", "codex-a"), b = await begin(fixture, "openai-codex", "codex-b");
  const first = await open(fixture, url("openai-codex", "events") + `?sessionId=${a.sessionId}`);
  const second = await open(fixture, url("openai-codex", "events") + `?sessionId=${b.sessionId}`);
  const bots = await open(fixture, "/api/bots/events");
  try {
    await first.read(); await second.read(); await bots.read();
    fixture.oauth.done(a.sessionId, { ok: true });
    assert.match(await first.read(), /event: done/);
    fixture.oauth.emit(b.sessionId, "notify", { type: "notify", event: { type: "progress", message: "only-second" } });
    assert.match(await second.read(), /only-second/);
    fixture.emit("/api/bots/events", "snapshot", { marker: "only-bots" });
    assert.match(await bots.read(), /only-bots/);
  } finally { first.abort(); second.abort(); bots.abort(); }
}));
