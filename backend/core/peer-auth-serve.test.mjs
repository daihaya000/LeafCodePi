import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPeerAuditLog, createPeerRateLimiter } from "./peer-auth-audit.mjs";
import { createPeerGrantStore } from "./peer-auth-grants.mjs";
import { createPeerAuthService, PEER_MIN_OAUTH_VALIDITY_MS } from "./peer-auth-serve.mjs";

const NOW = 1_000_000;

async function fixture({ stored = {}, auths = {}, accountId = null, providers = ["anthropic", "openrouter"], limit = 60 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-serve-"));
  const grants = createPeerGrantStore({ path: join(root, "peer-auth.json") });
  grants.setEnabled(true);
  const { grant, token } = grants.create({ label: "b", accountId, providers });
  const auditPath = join(root, "audit.jsonl");
  const calls = [];
  const state = { stored: { ...stored }, auths };
  const service = createPeerAuthService({
    grants,
    limiter: createPeerRateLimiter({ limit, windowMs: 60_000, now: () => NOW }),
    audit: createPeerAuditLog({ path: auditPath }),
    now: () => NOW,
    readStoredCredential: async (providerId) => state.stored[providerId],
    getAuth: async (providerId, account, options) => {
      calls.push({ providerId, account, options });
      const handler = state.auths[providerId];
      if (handler instanceof Error) throw handler;
      if (typeof handler === "function") handler(state);
      return handler && typeof handler === "object" ? handler : undefined;
    },
    listStoredProviders: async () => Object.entries(state.stored).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    listAccounts: async () => [{ accountId: null, label: "default" }, { accountId: "acc1", label: "work" }],
  });
  const audit = async () => (await readFile(auditPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { service, token, grant, calls, state, audit, auth: `Bearer ${token}`, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("rejects missing, malformed, wrong and disabled tokens identically with 401", async () => {
  const f = await fixture();
  try {
    for (const authorization of [undefined, "Bearer short", `Bearer ${"A".repeat(43)}`]) {
      const response = await f.service.resolve({ authorization, body: { providerId: "anthropic" } });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: "unauthorized" });
      assert.equal(response.headers["Cache-Control"], "no-store");
    }
    assert.equal((await f.service.list({ authorization: undefined })).status, 401);
    assert.equal((await f.audit()).every((entry) => entry.result === "unauthorized" && entry.peerId === null), true);
  } finally { await f.cleanup(); }
});

test("resolve refreshes OAuth through getAuth, re-reads, and strips the refresh token", async () => {
  const f = await fixture({
    stored: { anthropic: { type: "oauth", access: "old", refresh: "R-SECRET", expires: NOW + 1 } },
    auths: { anthropic: (state) => { state.stored.anthropic = { type: "oauth", access: "new", refresh: "R2-SECRET", expires: NOW + 3_600_000 }; } },
  });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { credential: { type: "oauth", access: "new", expires: NOW + 3_600_000 } });
    assert.equal(JSON.stringify(response).includes("SECRET"), false);
    assert.deepEqual(f.calls, [{ providerId: "anthropic", account: null, options: { minOAuthValidityMs: PEER_MIN_OAUTH_VALIDITY_MS } }]);
    assert.deepEqual((await f.audit()).map(({ peerId, action, providerId, result }) => [peerId, action, providerId, result]), [[f.grant.id, "resolve", "anthropic", "ok"]]);
  } finally { await f.cleanup(); }
});

test("an OAuth token that is still expired after refresh is not served", async () => {
  const f = await fixture({ stored: { anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW - 1 } } });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "unavailable" });
    assert.equal((await f.audit())[0].result, "error");
  } finally { await f.cleanup(); }
});

test("stored API keys are returned without calling getAuth; ambient keys fall back to getAuth", async () => {
  const f = await fixture({
    stored: { anthropic: { type: "api_key", key: "sk-stored", env: { A: "b" }, extra: 1 } },
    auths: { openrouter: { auth: { apiKey: "sk-ambient" } } },
  });
  try {
    const stored = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } });
    assert.deepEqual(stored.body, { credential: { type: "api_key", key: "sk-stored", env: { A: "b" } } });
    assert.equal(f.calls.length, 0);
    const ambient = await f.service.resolve({ authorization: f.auth, body: { providerId: "openrouter" } });
    assert.deepEqual(ambient.body, { credential: { type: "api_key", key: "sk-ambient" } });
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("nothing to materialize is 404; provider outside the grant or other account is 403", async () => {
  const f = await fixture({ providers: ["anthropic"] });
  try {
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } })).status, 404);
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "openrouter" } })).status, 403);
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: "acc1" } })).status, 403);
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "a/b" } })).status, 400);
    assert.equal((await f.service.resolve({ authorization: f.auth, body: null })).status, 400);
    assert.deepEqual((await f.audit()).map((entry) => entry.result), ["not-found", "forbidden", "forbidden"]);
  } finally { await f.cleanup(); }
});

test("a grant bound to an account resolves against that account", async () => {
  const f = await fixture({ accountId: "acc1", stored: { anthropic: { type: "api_key", key: "k" } } });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: "acc1" } });
    assert.equal(response.status, 200);
    const omitted = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } });
    assert.equal(omitted.status, 200);
    assert.equal((await f.audit()).every((entry) => entry.accountId === "acc1"), true);
  } finally { await f.cleanup(); }
});

test("runtime failures return an opaque 503 without leaking the error", async () => {
  const f = await fixture({
    stored: { anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW + 1 } },
    auths: { anthropic: new Error("refresh failed: token R-SECRET") },
  });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "unavailable" });
    assert.equal((await f.audit())[0].result, "error");
  } finally { await f.cleanup(); }
});

test("rate limit returns 429 with Retry-After and is audited", async () => {
  const f = await fixture({ limit: 1, stored: { anthropic: { type: "api_key", key: "k" } } });
  try {
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } })).status, 200);
    const limited = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic" } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["Retry-After"], "60");
    assert.equal((await f.audit()).at(-1).result, "rate-limited");
  } finally { await f.cleanup(); }
});

test("list shows only granted providers and the granted account, no secrets", async () => {
  const f = await fixture({
    providers: ["anthropic"],
    stored: { anthropic: { type: "oauth", access: "A-SECRET", refresh: "R", expires: NOW + 1 }, openrouter: { type: "api_key", key: "K-SECRET" } },
  });
  try {
    const response = await f.service.list({ authorization: f.auth });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { providers: [{ providerId: "anthropic", type: "oauth" }], accounts: [{ accountId: null, label: "default" }] });
    assert.equal(JSON.stringify(response).includes("SECRET"), false);
  } finally { await f.cleanup(); }
});
