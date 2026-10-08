import test from "node:test";
import assert from "node:assert/strict";
import { USAGE_ROUTES, publicUsageBody, publicUsageOperation, usageExternalCommand } from "./usage-contract.mjs";
import { jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const window = { id: "w", title: "Window", usedPercent: 10, resetsAt: null, windowMinutes: 300, countsTowardLimit: true, secret: "PRIVATE" };
const provider = { id: "openai-codex", instanceId: "account:a:openai-codex", accountId: "a", accountLabel: "Account", opencodeId: null, plan: "Pro", planMonthlyUsd: 20, usedPercent: 10, limited: false, maxed: false, resetsAt: null, updatedAt: null, error: null, windows: [window], credits: { title: "USD", used: 1, limit: 10, balance: 9, token: "PRIVATE" }, resetCreditsAvailable: 1, stale: true, usageDisplayOnly: true,
  tokenUsage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, responses: 1, startedAt: null, windows: [{ id: "w", title: "Window", status: "ready", validUntil: null, sampledTokens: 19, sampledPercent: 10, tokensPerPercent: 1.9, estimatedRemainingTokens: 171, token: "PRIVATE" }], token: "PRIVATE" }, authPath: "PRIVATE" };
const usage = { available: true, reason: null, schema: "codexbar.usage-snapshot/v1", generatedAt: null, subscriptionTotalMonthlyUsd: 20, providers: [provider], scope: { kind: "all", accountId: null, token: "PRIVATE" }, accounts: [{ id: "a", label: "Account", providers: ["openai-codex"], configuredProviders: ["openai-codex"], token: "PRIVATE" }], providerOrder: ["openai-codex"], token: "PRIVATE" };
test("usage routes distinguish configuration saves from external command admission", () => {
  assert.equal(Object.values(USAGE_ROUTES).flat().length, 5);
  assert.equal(jsonBusinessCommand("codexbar/providers", "PUT"), true); assert.equal(jsonBusinessCommand("codexbar/usage", "GET"), false);
  assert.equal(usageExternalCommand("codexbar/reset-credits", "POST"), true); assert.equal(usageExternalCommand("codexbar/reset-credits", "GET"), false);
});
test("deep usage DTO keeps scope/cache/telemetry semantics and strips private fields everywhere", () => {
  const result = publicJsonBusinessResult("codexbar/usage", { status: 200, headers: { "set-cookie": "PRIVATE" }, body: usage });
  assert.ok(result); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(result.body.providers[0].tokenUsage.windows[0].status, "ready"); assert.equal(result.body.providers[0].usageDisplayOnly, true);
  assert.equal(result.body.providers[0].windows[0].countsTowardLimit, true); assert.deepEqual(result.body.scope, { kind: "all", accountId: null });
  assert.equal(publicUsageBody("codexbar/usage", { ...usage, providers: [{ ...provider, plan: { token: "PRIVATE" } }] }, 200), null);
  assert.equal(publicUsageBody("codexbar/usage", { ...usage, providers: [{ ...provider, credits: { balance: {} } }] }, 200), null);
});
test("catalog/reset projections never forward secrets and false business outcomes remain HTTP 200", () => {
  assert.deepEqual(publicUsageBody("codexbar/providers", { providers: [{ id: "openai-codex", name: "Codex", enabled: true, configurable: true, token: "PRIVATE" }], version: "hash", config: { key: "PRIVATE" } }, 200), { providers: [{ id: "openai-codex", name: "Codex", enabled: true, configurable: true }], version: "hash" });
  const list = publicUsageBody("codexbar/reset-credits", { availableCount: 1, accountId: null, credits: [{ id: "c", title: "Credit", status: "available", expiresAt: null, grantedAt: null, description: null, token: "PRIVATE" }] }, 200);
  assert.ok(!JSON.stringify(list).includes("PRIVATE"));
  const nullable = publicUsageBody("codexbar/reset-credits", { availableCount: 1, accountId: null, credits: [{ id: "c", title: null, status: null, resetType: null, description: null, expiresAt: null, grantedAt: null }] }, 200);
  assert.deepEqual(nullable.credits[0], { id: "c", title: null, status: null, resetType: null, description: null, expiresAt: null, grantedAt: null });
  const outcome = publicUsageBody("codexbar/reset-credits", { ok: false, code: "nothing_to_reset", message: "safe", creditId: "c", accountId: null, windowsReset: null, operation: { id, execution: "complete", token: "PRIVATE" } }, 200);
  assert.equal(outcome.ok, false); assert.equal(outcome.operation.execution, "complete"); assert.ok(!JSON.stringify(outcome).includes("PRIVATE"));
  assert.equal(publicUsageBody("codexbar/reset-credits", { ok: true, code: "reset", creditId: "c", operation: { id, execution: "saved" } }, 200), null);
});
test("unknown operation acknowledges uncertainty and never claims persisted settings or redemption", () => {
  assert.deepEqual(publicUsageOperation({ id, execution: "unknown", saved: true }), { id, execution: "unknown" });
  assert.equal(publicUsageOperation({ id: "invalid", execution: "complete" }), null);
  assert.deepEqual(publicUsageBody("codexbar/reset-credits", { error: "failed", operation: { id, execution: "unknown" }, accessToken: "PRIVATE" }, 503), { error: "failed", operation: { id, execution: "unknown" } });
});
