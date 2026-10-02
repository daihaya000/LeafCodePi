import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpAuthRemoveRequest, publicMcpAuthRemoveResult } from "./mcp-auth-remove-request.mjs";

test("auth removal keeps owner defaults and normalizes bearer/header/OAuth aliases", () => {
  assert.deepEqual(parseMcpAuthRemoveRequest({}), { ok: true, value: {} });
  for (const type of ["bearer", "headers", "oauth"]) {
    for (const body of [{ type }, { action: type }, { type, action: type }]) {
      assert.deepEqual(parseMcpAuthRemoveRequest(body), { ok: true, value: { type } });
    }
  }
  assert.deepEqual(parseMcpAuthRemoveRequest(Object.create(null)), { ok: true, value: {} });
});
test("auth removal rejects malformed, conflicting, inherited and privileged fields", () => {
  for (const body of [null, [], new Date(), "headers", { type: "unknown" }, { type: "auto" }, { type: undefined },
    { type: "oauth", input: "private-fixture" }, { type: "oauth", action: "start" },
    { type: "headers", action: "bearer" }, { type: "headers", headers: { Authorization: "private-fixture" } },
    { token: "private-fixture" }, { configPath: "private-fixture" }, Object.create({ type: "headers" })]) {
    assert.deepEqual(parseMcpAuthRemoveRequest(body), { ok: false });
  }
});
test("auth removal publishes only safe metadata and reload counters", () => {
  const result = publicMcpAuthRemoveResult({ ok: true, headers: { Authorization: "private-fixture" },
    auth: { name: "fixture", authType: "headers", credentialConfigured: false, credentialSource: "none",
      credentialStatus: "missing", configPath: "private-path", credentialMessage: "private-fixture" },
    reload: { reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture"] } });
  assert.equal(result.auth.name, "fixture");
  assert.equal(JSON.stringify(result).includes("private"), false);
  for (const value of [null, {}, { ok: true }, { ok: true, auth: result.auth, reload: { reloaded: -1 } }]) {
    assert.equal(publicMcpAuthRemoveResult(value), null);
  }
});
