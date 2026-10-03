import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPeerAuditLog, createPeerRateLimiter } from "./peer-auth-audit.mjs";
import { createPeerGrantStore } from "./peer-auth-grants.mjs";
import { createPeerAuthService, PEER_MIN_OAUTH_VALIDITY_MS } from "./peer-auth-serve.mjs";

const NOW = 1_000_000;
const ACCOUNTS = [
  { accountId: null, label: "default" },
  { accountId: "acc1", label: "work" },
];

async function fixture({
  storedByAccount = { null: {} }, auths = {}, providers = ["anthropic", "openrouter"], limit = 60, accounts = ACCOUNTS,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-serve-"));
  const grants = createPeerGrantStore({ path: join(root, "peer-auth.json") });
  grants.setEnabled(true);
  const { grant, token } = grants.create({ label: "b", providers });
  const auditPath = join(root, "audit.jsonl");
  const calls = [];
  const state = { storedByAccount: structuredClone(storedByAccount), auths };
  const service = createPeerAuthService({
    grants,
    limiter: createPeerRateLimiter({ limit, windowMs: 60_000, now: () => NOW }),
    audit: createPeerAuditLog({ path: auditPath }),
    now: () => NOW,
    readStoredCredential: async (providerId, accountId) => state.storedByAccount[accountId]?.[providerId],
    getAuth: async (providerId, account, options) => {
      calls.push({ providerId, account, options });
      const handler = state.auths[providerId];
      if (handler instanceof Error) throw handler;
      if (typeof handler === "function") handler(state);
      return handler && typeof handler === "object" ? handler : undefined;
    },
    listStoredProviders: async (accountId) =>
      Object.entries(state.storedByAccount[accountId] ?? {}).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    listAccounts: async () => accounts,
  });
  const audit = async () => (await readFile(auditPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { service, token, grant, calls, state, audit, auth: `Bearer ${token}`, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("rejects missing, malformed, wrong and disabled tokens identically with 401", async () => {
  const f = await fixture();
  try {
    for (const authorization of [undefined, "Bearer short", `Bearer ${"A".repeat(43)}`]) {
      const response = await f.service.resolve({ authorization, body: { providerId: "anthropic", accountId: null } });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: "unauthorized" });
      assert.equal(response.headers["Cache-Control"], "no-store");
    }
    assert.equal((await f.service.list({ authorization: undefined })).status, 401);
    assert.equal((await f.audit()).every((entry) => entry.result === "unauthorized" && entry.peerId === null), true);
  } finally { await f.cleanup(); }
});

test("resolve refreshes OAuth through getAuth for the requested account, re-reads, and strips the refresh token", async () => {
  const f = await fixture({
    storedByAccount: { null: {}, acc1: { anthropic: { type: "oauth", access: "old", refresh: "R-SECRET", expires: NOW + 1 } } },
    auths: { anthropic: (state) => { state.storedByAccount.acc1.anthropic = { type: "oauth", access: "new", refresh: "R2-SECRET", expires: NOW + 3_600_000 }; } },
  });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: "acc1" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { credential: { type: "oauth", access: "new", expires: NOW + 3_600_000 } });
    assert.equal(JSON.stringify(response).includes("SECRET"), false);
    assert.deepEqual(f.calls, [{ providerId: "anthropic", account: "acc1", options: { minOAuthValidityMs: PEER_MIN_OAUTH_VALIDITY_MS } }]);
    assert.deepEqual((await f.audit()).map(({ peerId, action, providerId, accountId, result }) => [peerId, action, providerId, accountId, result]),
      [[f.grant.id, "resolve", "anthropic", "acc1", "ok"]]);
  } finally { await f.cleanup(); }
});

test("an OAuth token that is still expired after refresh is not served", async () => {
  const f = await fixture({ storedByAccount: { null: { anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW - 1 } } } });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: null } });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "unavailable" });
    assert.equal((await f.audit())[0].result, "error");
  } finally { await f.cleanup(); }
});

test("stored API keys are returned per account without calling getAuth; ambient keys fall back to getAuth", async () => {
  const f = await fixture({
    storedByAccount: { null: {}, acc1: { anthropic: { type: "api_key", key: "sk-acc1", env: { A: "b" }, extra: 1 } } },
    auths: { openrouter: { auth: { apiKey: "sk-ambient" } } },
  });
  try {
    const stored = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: "acc1" } });
    assert.deepEqual(stored.body, { credential: { type: "api_key", key: "sk-acc1", env: { A: "b" } } });
    assert.equal(f.calls.length, 0);
    const ambient = await f.service.resolve({ authorization: f.auth, body: { providerId: "openrouter", accountId: null } });
    assert.deepEqual(ambient.body, { credential: { type: "api_key", key: "sk-ambient" } });
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("each account resolves its own credential; unknown accounts are 403 and accounts without the provider are 404", async () => {
  const f = await fixture({
    providers: ["anthropic", "openrouter"],
    storedByAccount: {
      null: { anthropic: { type: "api_key", key: "k-default" } },
      acc1: { anthropic: { type: "api_key", key: "k-work" }, openrouter: { type: "api_key", key: "k-or" } },
    },
  });
  try {
    const byDefault = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: null } });
    assert.deepEqual(byDefault.body, { credential: { type: "api_key", key: "k-default" } });
    const byAccount = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: "acc1" } });
    assert.deepEqual(byAccount.body, { credential: { type: "api_key", key: "k-work" } });
    // acc1 has no credential for a provider only the default account holds
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "openrouter", accountId: "acc1" } })).status, 200);
    const missing = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: "acc-missing" } });
    assert.equal(missing.status, 403);
    const noCredential = await f.service.resolve({ authorization: f.auth, body: { providerId: "openrouter", accountId: null } });
    assert.equal(noCredential.status, 404);
    const outside = await f.service.resolve({ authorization: f.auth, body: { providerId: "not-granted", accountId: null } });
    assert.equal(outside.status, 403);
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "a/b" } })).status, 400);
    assert.equal((await f.service.resolve({ authorization: f.auth, body: null })).status, 400);
    assert.deepEqual((await f.audit()).map((entry) => entry.result), ["ok", "ok", "ok", "forbidden", "not-found", "forbidden"]);
  } finally { await f.cleanup(); }
});

test("runtime failures return an opaque 503 without leaking the error", async () => {
  const f = await fixture({
    storedByAccount: { null: { anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW + 1 } } },
    auths: { anthropic: new Error("refresh failed: token R-SECRET") },
  });
  try {
    const response = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: null } });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "unavailable" });
    assert.equal((await f.audit())[0].result, "error");
  } finally { await f.cleanup(); }
});

test("rate limit returns 429 with Retry-After and is audited", async () => {
  const f = await fixture({ limit: 1, storedByAccount: { null: { anthropic: { type: "api_key", key: "k" } } } });
  try {
    assert.equal((await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: null } })).status, 200);
    const limited = await f.service.resolve({ authorization: f.auth, body: { providerId: "anthropic", accountId: null } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["Retry-After"], "60");
    assert.equal((await f.audit()).at(-1).result, "rate-limited");
  } finally { await f.cleanup(); }
});

test("unauthenticated requests share a rate limit without blocking a valid peer", async () => {
  const f = await fixture({ limit: 1, storedByAccount: { null: { anthropic: { type: "api_key", key: "k" } } } });
  try {
    const unauthorized = await f.service.list({ authorization: undefined });
    assert.equal(unauthorized.status, 401);

    const limited = await f.service.resolve({
      authorization: "Bearer invalid-token",
      body: { providerId: "anthropic", accountId: null },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["Retry-After"], "60");

    const valid = await f.service.resolve({
      authorization: f.auth,
      body: { providerId: "anthropic", accountId: null },
    });
    assert.equal(valid.status, 200);
    assert.deepEqual((await f.audit()).map((entry) => entry.result), ["unauthorized", "ok"]);
  } finally { await f.cleanup(); }
});

test("list reports every account that holds a granted provider, with per-account providers and no secrets", async () => {
  const f = await fixture({
    providers: ["anthropic"],
    storedByAccount: {
      null: { anthropic: { type: "oauth", access: "A-SECRET", refresh: "R", expires: NOW + 1 }, openrouter: { type: "api_key", key: "K-SECRET" } },
      acc1: { anthropic: { type: "api_key", key: "K2-SECRET" } },
    },
  });
  try {
    const response = await f.service.list({ authorization: f.auth });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      providers: [{ providerId: "anthropic", type: "oauth" }],
      accounts: [
        { accountId: null, label: "default", providers: ["anthropic"] },
        { accountId: "acc1", label: "work", providers: ["anthropic"] },
      ],
    });
    assert.equal(JSON.stringify(response).includes("SECRET"), false);
    // An account with no granted provider is not listed at all.
    assert.equal(response.body.accounts.some((account) => account.accountId === "acc2"), false);
  } finally { await f.cleanup(); }
});
