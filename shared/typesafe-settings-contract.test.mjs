import assert from "node:assert/strict";
import test from "node:test";
import { TYPESAFE_SETTINGS_ROUTES, typesafeSettingsTarget, typesafeSettingsBodyLimit, publicTypesafeSettingsBody } from "./typesafe-settings-contract.mjs";
import { jsonBusinessBodyLimit, jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
test("two exact routes, six operations and bounded opaque cookie/baseline bodies", () => {
  assert.equal(Object.values(TYPESAFE_SETTINGS_ROUTES).flat().length, 6);
  for (const path of ["typesafe-cookie", "typesafe-baseline"]) {
    assert.equal(typesafeSettingsTarget(path).route, path); assert.equal(jsonBusinessCommand(path, "GET"), false);
    for (const method of ["POST", "DELETE"]) assert.equal(jsonBusinessCommand(path, method), true);
  }
  for (const path of ["typesafe-cookie/../", "typesafe-cookie/", "%74ypesafe-cookie"]) assert.equal(typesafeSettingsTarget(path), null);
  assert.equal(typesafeSettingsBodyLimit("typesafe-cookie", "POST"), 8 * 1024 * 1024);
  assert.equal(jsonBusinessBodyLimit("typesafe-baseline", "POST"), 4096); assert.equal(jsonBusinessBodyLimit("typesafe-cookie", "DELETE"), 4096);
});
test("success projection contains only status/billing-display value and public ID receipt", () => {
  const operation = { id: "11111111-0123-4321-abcd-eeeeeeeeeeee", execution: "complete", cookies: "SECRET" };
  for (const route of ["typesafe-cookie", "typesafe-baseline"]) for (const method of ["GET", "POST", "DELETE"]) {
    const fields = route === "typesafe-cookie" ? { configured: method !== "DELETE" } : { baselineUsd: method === "DELETE" ? null : 5.5 };
    const result = publicJsonBusinessResult(route, { status: 200, headers: { "set-cookie": "SECRET", "cache-control": "no-store, private" }, body: { ...fields, ok: true, operation, cookies: "SECRET", organizationId: "SECRET", path: "SECRET", sdk: { credential: "SECRET" } } }, method);
    assert.ok(result); assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.deepEqual(result.body, { ...(method === "GET" ? {} : { ok: true }), ...fields, operation: { id: operation.id, execution: "complete" } });
  }
});
test("malformed successes fail closed; baseline legacy reads, refusals and unknown receipts retain their semantics", () => {
  for (const [route, method, body] of [["typesafe-cookie", "GET", { configured: "false" }], ["typesafe-cookie", "POST", { ok: true, configured: false }], ["typesafe-cookie", "DELETE", { ok: true, configured: true }], ["typesafe-baseline", "POST", { ok: true, baselineUsd: null }], ["typesafe-baseline", "POST", { ok: true, baselineUsd: 1_000_001 }], ["typesafe-baseline", "DELETE", { ok: true, baselineUsd: 5 }], ["typesafe-baseline", "GET", { baselineUsd: -1 }], ["typesafe-baseline", "GET", { baselineUsd: Infinity }]]) assert.equal(publicTypesafeSettingsBody(route, body, 200, method), null);
  assert.deepEqual(publicTypesafeSettingsBody("typesafe-baseline", { baselineUsd: 1_000_001 }, 200, "GET"), { baselineUsd: 1_000_001 });
  assert.deepEqual(publicTypesafeSettingsBody("typesafe-cookie", { error: "refused", cookies: "SECRET" }, 400, "POST"), { error: "refused" });
  assert.equal(publicTypesafeSettingsBody("typesafe-cookie", { configured: true, operation: { id: "bad", execution: "complete" } }, 200, "GET"), null);
});
