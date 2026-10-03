import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePeerBearer, parsePeerResolveRequest, parsePeerResolveResponse, parsePeerUsageRequest,
  parsePeerUsageResponse, publicPeerCredential, publicPeerList, publicPeerUsage,
} from "./peer-auth-wire.mjs";

const token = "A".repeat(43);

test("bearer header accepts only well-formed peer tokens", () => {
  assert.equal(parsePeerBearer(`Bearer ${token}`), token);
  assert.equal(parsePeerBearer(`bearer ${token}`), token);
  for (const bad of [undefined, "", "Bearer", `Bearer ${"A".repeat(10)}`, `Basic ${token}`, `Bearer ${token} x`, `Bearer ${token}!`]) {
    assert.equal(parsePeerBearer(bad), null);
  }
});

test("resolve request is strict and defaults to the default account", () => {
  assert.deepEqual(parsePeerResolveRequest({ providerId: "anthropic" }), { ok: true, value: { providerId: "anthropic", accountId: null } });
  assert.deepEqual(parsePeerResolveRequest({ providerId: "openai-codex", accountId: "acc_1" }), { ok: true, value: { providerId: "openai-codex", accountId: "acc_1" } });
  for (const bad of [null, [], "x", {}, { providerId: "" }, { providerId: "a/b" }, { providerId: "a", accountId: "../x" },
    { providerId: "a", accountId: 1 }, { providerId: "a", extra: 1 }, Object.create({ providerId: "a" })]) {
    assert.deepEqual(parsePeerResolveRequest(bad), { ok: false });
  }
});

test("credentials never expose refresh tokens or unknown fields", () => {
  assert.deepEqual(publicPeerCredential({ type: "oauth", access: "a", refresh: "r", expires: 5, accountId: "z" }), { type: "oauth", access: "a", expires: 5 });
  assert.deepEqual(publicPeerCredential({ type: "api_key", key: "k", env: { A: "b" }, other: 1 }), { type: "api_key", key: "k", env: { A: "b" } });
  assert.deepEqual(publicPeerCredential({ type: "api_key", key: "k" }), { type: "api_key", key: "k" });
  for (const bad of [null, {}, { type: "oauth", access: "", expires: 1 }, { type: "oauth", access: "a", expires: Infinity },
    { type: "oauth", access: "a\n", expires: 1 }, { type: "api_key" }, { type: "api_key", key: "k", env: { A: 1 } },
    { type: "api_key", key: "k", env: [] }, { type: "other", key: "k" }]) {
    assert.equal(publicPeerCredential(bad), null);
  }
});

test("resolve response requires exactly one valid credential", () => {
  assert.deepEqual(parsePeerResolveResponse({ credential: { type: "oauth", access: "a", refresh: "r", expires: 9 } }), { credential: { type: "oauth", access: "a", expires: 9 } });
  assert.equal(parsePeerResolveResponse({ credential: { type: "oauth", access: "a", expires: 9 }, extra: 1 }), null);
  assert.equal(parsePeerResolveResponse({}), null);
  assert.equal(parsePeerResolveResponse(null), null);
});

test("peer usage accepts named accounts only and strips non-usage fields", () => {
  assert.deepEqual(parsePeerUsageRequest({ accountId: "acc_1" }), { ok: true, value: { accountId: "acc_1" } });
  for (const bad of [null, {}, { accountId: null }, { accountId: "../x" }, { accountId: "acc1", extra: true }]) {
    assert.deepEqual(parsePeerUsageRequest(bad), { ok: false });
  }
  const snapshot = {
    providerId: "openai-codex", providerName: "Codex", plan: "Plus",
    windows: [{ id: "5h", title: "5時間", usedPercent: 25, resetsAt: new Date(1_700_000_000_000), windowDurationMs: 18_000_000, countsTowardLimit: true }],
    creditsBalance: null, creditsLabel: null, creditsEnabled: false, creditsTitle: null, creditsUsed: null, creditsLimit: null,
    sourceLabel: null, updatedAt: new Date(1_700_000_000_000), isStale: false, rateLimitResetCreditsAvailable: 2,
    accountEmail: "private@example.com", access: "SECRET", extra: "drop",
  };
  const response = publicPeerUsage({ providers: [{ providerId: "openai-codex", snapshot }] });
  assert.deepEqual(response.providers[0].snapshot, {
    providerId: "openai-codex", providerName: "Codex", plan: "Plus",
    windows: [{ id: "5h", title: "5時間", usedPercent: 25, resetsAt: "2023-11-14T22:13:20.000Z", windowDurationMs: 18_000_000, countsTowardLimit: true }],
    creditsBalance: null, creditsLabel: null, creditsEnabled: false, creditsTitle: null, creditsUsed: null, creditsLimit: null,
    sourceLabel: null, updatedAt: "2023-11-14T22:13:20.000Z", isStale: false, rateLimitResetCreditsAvailable: 2,
  });
  assert.equal(JSON.stringify(response).includes("SECRET"), false);
  assert.equal(JSON.stringify(response).includes("private@example.com"), false);
  assert.deepEqual(parsePeerUsageResponse(JSON.parse(JSON.stringify(response))), response);
  assert.equal(publicPeerUsage({ providers: [{ providerId: "openai-codex", snapshot: { providerId: "openai-codex" } }] }), null);
  assert.equal(publicPeerUsage({ providers: [{ providerId: "openrouter", snapshot }] }), null);
});

test("list is metadata only and validated", () => {
  const list = { providers: [{ providerId: "anthropic", type: "oauth", secret: "x" }], accounts: [
    { accountId: null, label: "default", providers: ["anthropic", "anthropic"], token: "x" },
    { accountId: "a1", label: "work", providers: ["openai-codex"] },
  ] };
  assert.deepEqual(publicPeerList(list), {
    providers: [{ providerId: "anthropic", type: "oauth" }],
    accounts: [
      { accountId: null, label: "default", providers: ["anthropic"] },
      { accountId: "a1", label: "work", providers: ["openai-codex"] },
    ],
  });
  assert.equal(publicPeerList({ providers: [{ providerId: "a b", type: "oauth" }], accounts: [] }), null);
  assert.equal(publicPeerList({ providers: [{ providerId: "a", type: "x" }], accounts: [] }), null);
  assert.equal(publicPeerList({ providers: [], accounts: [{ accountId: "bad id", label: "l", providers: ["a"] }] }), null);
  assert.equal(publicPeerList({ providers: [], accounts: [{ accountId: null, label: "l" }] }), null);
  assert.equal(publicPeerList({ providers: [], accounts: [{ accountId: null, label: "l", providers: ["bad id"] }] }), null);
  assert.equal(publicPeerList({ providers: [] }), null);
});
