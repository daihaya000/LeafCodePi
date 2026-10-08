import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_ROUTES, accountTarget, publicAccountBody } from "./account-contract.mjs";
import { jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
const account = { id: "fixture", label: "Fixture", enabled: true, providers: ["anthropic"], createdAt: "now", updatedAt: "now", token: "PRIVATE", authPath: "PRIVATE" };
test("account route mapping validates identifiers, decodes once and registers all operations", () => {
  assert.equal(Object.keys(ACCOUNT_ROUTES).length, 9); assert.equal(Object.values(ACCOUNT_ROUTES).flat().length, 19);
  assert.deepEqual(accountTarget("accounts/%66ixture/anthropic-cookie"), { route: "accounts/[id]/anthropic-cookie", params: { id: "fixture" } });
  for (const path of ["accounts/%2F", "accounts/%252F", "accounts/..", "accounts/%zz", "accounts/fixture/unregistered", "accounts/fixture/anthropic-cookie/extra"]) assert.equal(accountTarget(path), null);
  assert.equal(jsonBusinessCommand("accounts/fixture/openrouter-credits", "POST"), true);
  assert.equal(jsonBusinessCommand("accounts/fixture/auth-status", "GET"), false);
});
test("account DTO projection strips credential and runtime fields including nested records", () => {
  for (const input of [{ account }, { accounts: [account] }]) {
    const projected = publicJsonBusinessResult("accounts", { status: 200, headers: { "set-cookie": "PRIVATE" }, body: { ...input, managementKey: "PRIVATE" } });
    assert.ok(projected); assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
  }
  assert.equal(publicAccountBody("accounts", { account: { ...account, providers: [{}] } }, 200), null);
  assert.equal(publicAccountBody("accounts", { account: { ...account, note: {} } }, 200), null);
});
test("auth-status exposes only typed configured flags and credential kinds", () => {
  const result = publicAccountBody("accounts/[id]/auth-status", { providers: ["anthropic"], credentialKinds: { anthropic: "oauth", token: "PRIVATE" }, peer: false, ollamaCookieConfigured: false, opencodeGoCookieConfigured: false, anthropicCookieConfigured: true, openrouterManagementKeyConfigured: false, anthropicCreditBaseline: 10, openrouterCreditBaseline: null, cookies: "PRIVATE" }, 200);
  assert.deepEqual(result.credentialKinds, { anthropic: "oauth" }); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(publicAccountBody("accounts/[id]/auth-status", { ...result, credentialKinds: { anthropic: { token: "PRIVATE" } } }, 200), null);
});
test("success, partial error, null baseline and invalid acknowledgement schemas stay explicit", () => {
  assert.deepEqual(publicAccountBody("accounts/[id]/openrouter-baseline", { ok: true, baselineUsd: null, managementKey: "PRIVATE" }, 200), { ok: true, baselineUsd: null });
  assert.deepEqual(publicAccountBody("accounts/[id]/openrouter-credits", { error: "safe", configured: true, token: "PRIVATE" }, 500), { error: "safe", configured: true });
  assert.equal(publicAccountBody("accounts/[id]/openrouter-credits", { ok: true, configured: {} }, 200), null);
  assert.equal(publicAccountBody("accounts", { accounts: [], mutation: { saved: true } }, 200), null);
});
