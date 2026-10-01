import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKEND_HEALTH_PATH, BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { backendHealthUrl, readBackendHealth, waitForBackendReady } from "./backend-health.js";
import { closeBackend, createBackendServer, listenBackend } from "../../backend/src/server.mjs";

const TOKEN = "t".repeat(40);
const BASE = "http://127.0.0.1:18776";

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("the health URL is the base plus the internal path", () => {
  assert.equal(backendHealthUrl(BASE), `${BASE}${BACKEND_HEALTH_PATH}`);
  assert.equal(backendHealthUrl(`${BASE}/`), `${BASE}${BACKEND_HEALTH_PATH}`);
});

test("a ready Backend of the pinned generation is ready", async () => {
  const calls = [];
  const result = await readBackendHealth({
    baseUrl: BASE,
    token: TOKEN,
    expectedGeneration: "gen-a",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { ready: true, status: "ready", runtimeGeneration: "gen-a", pid: 1 });
    },
  });
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    ready: true,
    generation: { pinned: "gen-a", running: "gen-a", matches: true },
  });
  assert.equal(calls[0].url, backendHealthUrl(BASE));
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers[BACKEND_PROTOCOL_HEADER], String(BACKEND_PROTOCOL_VERSION));
});

test("a listening socket that is not ready, or a different generation, is not ready", async () => {
  const read = (body) =>
    readBackendHealth({ baseUrl: BASE, token: TOKEN, expectedGeneration: "gen-a", fetchImpl: async () => jsonResponse(200, body) });
  // Startup has not finished.
  assert.equal((await read({ ready: false, status: "starting", runtimeGeneration: "gen-a" })).ready, false);
  // Attached, but not the build the Host pinned.
  assert.deepEqual((await read({ ready: true, runtimeGeneration: "gen-b" })).generation, {
    pinned: "gen-a",
    running: "gen-b",
    matches: false,
  });
  // No expectation: readiness is the Backend's own answer.
  const unpinned = await readBackendHealth({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => jsonResponse(200, { ready: true, runtimeGeneration: null }),
  });
  assert.equal(unpinned.ready, true);
});

test("transport and auth failures are reasons, not exceptions", async () => {
  assert.deepEqual(await readBackendHealth({ baseUrl: BASE, token: "" }), { ok: false, reason: "not-configured" });
  const failing = (error) =>
    readBackendHealth({ baseUrl: BASE, token: TOKEN, fetchImpl: async () => { throw error; } });
  assert.deepEqual(await failing(new Error("ECONNREFUSED")), { ok: false, reason: "unreachable" });
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.deepEqual(await failing(abort), { ok: false, reason: "timeout" });
  const status = (code) => readBackendHealth({ baseUrl: BASE, token: TOKEN, fetchImpl: async () => jsonResponse(code, {}) });
  assert.deepEqual(await status(401), { ok: false, reason: "unauthorized", status: 401 });
  assert.deepEqual(await status(409), { ok: false, reason: "incompatible", status: 409 });
  assert.deepEqual(await status(500), { ok: false, reason: "bad-response", status: 500 });
  const brokenJson = await readBackendHealth({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error("not json"); } }),
  });
  assert.deepEqual(brokenJson, { ok: false, reason: "bad-response", status: 200 });
});

test("a real detached Backend is reachable at HTTP 503, but never ready", async (t) => {
  const server = createBackendServer({ token: TOKEN });
  t.after(() => closeBackend(server));
  const { port } = await listenBackend(server, 0);
  assert.deepEqual(await readBackendHealth({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, expectedGeneration: "gen-a" }), {
    ok: true,
    status: 503,
    ready: false,
    generation: { pinned: "gen-a", running: null, matches: false },
  });
});

test("an arbitrary or contradictory HTTP 503 is not valid Backend health", async () => {
  for (const body of [{}, { ready: false }, { service: "leafcode-pi-backend", protocolVersion: BACKEND_PROTOCOL_VERSION, ready: true, status: "ready" }]) {
    assert.deepEqual(await readBackendHealth({ baseUrl: BASE, token: TOKEN, fetchImpl: async () => jsonResponse(503, body) }), {
      ok: false, reason: "bad-response", status: 503,
    });
  }
});

test("waiting polls until ready", async () => {
  let reads = 0;
  const result = await waitForBackendReady({
    read: async () => {
      reads += 1;
      return reads < 3 ? { ok: true, ready: false, generation: { pinned: null, running: null, matches: true } } : { ok: true, ready: true };
    },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test("waiting gives up at the deadline, and stops early on a failure a retry cannot fix", async () => {
  let clock = 0;
  const never = await waitForBackendReady({
    read: async () => ({ ok: false, reason: "unreachable" }),
    now: () => clock,
    timeoutMs: 2_000,
    sleep: async () => { clock += 1_000; },
  });
  assert.equal(never.ok, false);
  assert.equal(never.reason, "timeout");
  assert.equal(never.attempts, 3);

  let unauthorizedReads = 0;
  const unauthorized = await waitForBackendReady({
    read: async () => {
      unauthorizedReads += 1;
      return { ok: false, reason: "unauthorized" };
    },
    sleep: async () => { throw new Error("must not sleep"); },
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, "unauthorized");
  assert.equal(unauthorizedReads, 1, "a bad token will not fix itself");
});

test("waiting without a read function is refused", async () => {
  await assert.rejects(() => waitForBackendReady({}), /read is required/);
});
