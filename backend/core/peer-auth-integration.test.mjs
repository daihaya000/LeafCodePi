import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPeerAuditLog, createPeerRateLimiter } from "./peer-auth-audit.mjs";
import { createPeerGrantStore } from "./peer-auth-grants.mjs";
import { createRemotePeerCredentialStore } from "./peer-auth-remote-store.mjs";
import { createPeerAuthService } from "./peer-auth-serve.mjs";

// A (sharing LCP) and B (consuming LCP) over a real loopback HTTP connection. A's auth.json is a real
// file; A's SDK refresh is simulated by rewriting it inside getAuth, as the SDK does under its file lock.

const REFRESH_SECRET = "REFRESH-TOKEN-MUST-NEVER-LEAVE-A";

async function startA({ stored }) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-integration-"));
  const authPath = join(root, "auth.json");
  await writeFile(authPath, JSON.stringify(stored), "utf8");
  const grants = createPeerGrantStore({ path: join(root, "peer-auth.json") });
  grants.setEnabled(true);
  const audit = createPeerAuditLog({ path: join(root, "audit.jsonl") });
  const state = { time: Date.now(), refreshes: 0, bodies: [] };
  const readAuth = async () => JSON.parse(await readFile(authPath, "utf8"));
  const service = createPeerAuthService({
    grants, audit, limiter: createPeerRateLimiter({ limit: 1000 }), now: () => state.time,
    readStoredCredential: async (providerId) => (await readAuth())[providerId],
    getAuth: async (providerId, _account, { minOAuthValidityMs }) => {
      const auth = await readAuth();
      const credential = auth[providerId];
      if (credential?.type === "oauth" && credential.expires - state.time < minOAuthValidityMs) {
        state.refreshes += 1;
        auth[providerId] = { ...credential, access: `access-${state.refreshes}`, refresh: `${REFRESH_SECRET}-${state.refreshes}`, expires: state.time + 60 * 60_000 };
        await writeFile(authPath, JSON.stringify(auth), "utf8");
      }
      return undefined;
    },
    listStoredProviders: async () => Object.entries(await readAuth()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    listAccounts: async () => [{ accountId: null, label: "default" }],
  });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const authorization = request.headers.authorization;
    const result = request.method === "GET" && request.url === "/api/peer-auth/list"
      ? await service.list({ authorization })
      : request.method === "POST" && request.url === "/api/peer-auth/resolve"
        ? await service.resolve({ authorization, body: (() => { try { return JSON.parse(body); } catch { return null; } })() })
        : { status: 404, body: { error: "not-found" }, headers: {} };
    const text = JSON.stringify(result.body);
    state.bodies.push(text);
    response.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    response.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    grants, audit, state, url, authPath,
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
    cleanup: async (running = true) => { if (running) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }).catch(() => undefined); await rm(root, { recursive: true, force: true }); },
  };
}

const oauth = (expiresInMs) => ({ type: "oauth", access: "access-0", refresh: `${REFRESH_SECRET}-0`, expires: Date.now() + expiresInMs });

test("B obtains a refreshed OAuth credential from A and never sees A's refresh token", async () => {
  const a = await startA({ stored: { anthropic: oauth(60_000), openrouter: { type: "api_key", key: "sk-or" } } });
  try {
    const { token } = a.grants.create({ label: "b", providers: ["anthropic", "openrouter"] });
    const b = createRemotePeerCredentialStore({ peerUrl: a.url, token });
    const credential = await b.read("anthropic");
    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, "access-1");
    assert.equal(credential.refresh, "");
    assert.equal(a.state.refreshes, 1);
    assert.deepEqual(await b.read("openrouter"), { type: "api_key", key: "sk-or" });
    assert.deepEqual(await b.list(), [{ providerId: "anthropic", type: "oauth" }, { providerId: "openrouter", type: "api_key" }]);
    assert.equal(a.state.bodies.some((body) => body.includes(REFRESH_SECRET)), false);
    assert.equal(JSON.stringify(a.audit.read()).includes("access-1"), false);
    assert.deepEqual(a.audit.read().map((entry) => [entry.action, entry.providerId, entry.result]),
      [["resolve", "anthropic", "ok"], ["resolve", "openrouter", "ok"], ["list", null, "ok"]]);
  } finally { await a.cleanup(); }
});

test("B's SDK-driven modify triggers a fresh refresh on A, not on B", async () => {
  const a = await startA({ stored: { anthropic: oauth(60 * 60_000) } });
  try {
    const { token } = a.grants.create({ label: "b", providers: ["anthropic"] });
    const b = createRemotePeerCredentialStore({ peerUrl: a.url, token });
    assert.equal((await b.read("anthropic")).access, "access-0");
    a.state.time += 55 * 60_000; // A's token is now within A's 10 minute window
    const refreshed = await b.modify("anthropic", async () => assert.fail("B must never run the SDK refresh callback"));
    assert.equal(refreshed.access, "access-1");
    assert.equal(a.state.refreshes, 1);
  } finally { await a.cleanup(); }
});

test("a provider outside the grant, a revoked grant and disabled sharing are all refused", async () => {
  const a = await startA({ stored: { anthropic: oauth(60 * 60_000), openrouter: { type: "api_key", key: "sk-or" } } });
  try {
    const { grant, token } = a.grants.create({ label: "b", providers: ["anthropic"] });
    const b = createRemotePeerCredentialStore({ peerUrl: a.url, token });
    await assert.rejects(b.read("openrouter"), /\(403\)/);
    assert.equal((await b.read("anthropic")).type, "oauth");
    a.grants.setEnabled(false);
    await assert.rejects(createRemotePeerCredentialStore({ peerUrl: a.url, token }).read("anthropic"), /\(401\)/);
    a.grants.setEnabled(true);
    a.grants.revoke(grant.id);
    await assert.rejects(createRemotePeerCredentialStore({ peerUrl: a.url, token }).read("anthropic"), /\(401\)/);
    await assert.rejects(createRemotePeerCredentialStore({ peerUrl: a.url, token: "x".repeat(43) }).read("anthropic"), /\(401\)/);
  } finally { await a.cleanup(); }
});

test("when A goes away B keeps using a still-valid token and fails once it expires", async () => {
  const a = await startA({ stored: { anthropic: oauth(60 * 60_000) } });
  let time = Date.now();
  try {
    const { token } = a.grants.create({ label: "b", providers: ["anthropic"] });
    const b = createRemotePeerCredentialStore({ peerUrl: a.url, token, now: () => time, timeoutMs: 2000 });
    const first = await b.read("anthropic");
    await a.stop();
    time += 30 * 60_000;
    assert.equal((await b.read("anthropic")).access, first.access);
    time = first.expires + 1;
    await assert.rejects(b.read("anthropic"), /Peer auth request failed/);
  } finally { await a.cleanup(false); }
});
