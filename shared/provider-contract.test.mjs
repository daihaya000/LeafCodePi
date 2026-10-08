import assert from "node:assert/strict";
import test from "node:test";
import { providerTarget, publicProviderBody } from "./provider-contract.mjs";
import { jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
test("provider target precedence and identifiers decode only once", () => {
  assert.deepEqual(providerTarget("provider-models/order"), { route: "provider-models/order", params: {} });
  assert.deepEqual(providerTarget("providers/leafcodecloud/base-url"), { route: "providers/[id]/base-url", params: { id: "leafcodecloud" } });
  assert.deepEqual(providerTarget("provider-models/a%3A%3Ab%252Fc"), { route: "provider-models/[key]", params: { key: "a::b%2Fc" } });
  assert.equal(providerTarget("providers/%xx"), null); assert.equal(providerTarget("providers/a/login"), null);
  assert.equal(jsonBusinessCommand("providers/a", "PATCH"), true); assert.equal(jsonBusinessCommand("models", "GET"), false);
});
test("provider public DTO preserves catalog semantics but never projects arbitrary nested SDK fields", () => {
  const auth = publicProviderBody("providers", { providers: [{ id: "p", name: "P", authenticated: true, methods: ["api_key"], token: "PRIVATE" }] }, 200);
  assert.deepEqual(auth.providers, [{ id: "p", name: "P", authenticated: true, methods: ["api_key"] }]);
  const catalog = publicJsonBusinessResult("provider-models", { status: 200, body: { providers: [{ id: "p", name: "P", enabled: true, accountIds: ["a"], token: "PRIVATE", models: [{ id: "m", name: "M", enabled: true, token: "PRIVATE" }] }] }, headers: { "set-cookie": "PRIVATE" } });
  assert.ok(!JSON.stringify(catalog).includes("PRIVATE")); assert.deepEqual(catalog.body.providers[0].accountIds, ["a"]);
  assert.equal(publicProviderBody("models", { models: [{}] }, 200), null); assert.equal(publicProviderBody("providers", { providers: [{}] }, 200), null);
});
test("provider public DTO preserves saved/deferred or partial receipts without adding private properties", () => {
  const mutation = { operationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", revision: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb", saved: true, saveStatus: "complete", apply: "deferred", recovery: "none", token: "PRIVATE" };
  const result = publicProviderBody("providers/[id]/base-url", { baseUrl: "http://localhost:1/v1", mutation }, 200);
  assert.equal(result.mutation.apply, "deferred"); assert.equal(result.mutation.token, undefined);
  const partial = publicProviderBody("provider-models/order", { error: "Failure", mutation: { ...mutation, saveStatus: "partial", apply: "failed" } }, 500);
  assert.equal(partial.mutation.saved, true); assert.equal(partial.mutation.saveStatus, "partial");
});
