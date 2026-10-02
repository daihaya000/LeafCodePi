import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpBearerRemoveRequest, publicMcpBearerRemoveResult } from "./mcp-bearer-remove-request.mjs";
test("bearer removal normalizes explicit aliases and preserves owner-resolved defaults", () => {
  assert.deepEqual(parseMcpBearerRemoveRequest({}), { ok: true, value: {} });
  for (const body of [{ type: "bearer" }, { action: "bearer" }, { type: "bearer", action: "bearer" }]) {
    assert.deepEqual(parseMcpBearerRemoveRequest(body), { ok: true, value: { type: "bearer" } });
  }
});
test("removal refuses other methods, credentials, paths and inherited selectors", () => {
  for (const body of [null, [], { type: "headers" }, { type: "oauth" }, { action: "unknown" }, { type: "bearer", action: "remove" },
    { type: "bearer", token: "private-fixture-secret" }, { configPath: "other" }, { headers: {} }, Object.create({ type: "bearer" })]) {
    assert.deepEqual(parseMcpBearerRemoveRequest(body), { ok: false });
  }
});
test("removal publishes only safe metadata, including changed auth modes, and reload counters", () => {
  const base = { ok: true, token: "private-fixture-secret", auth: { name: "fixture", configPath: "owner-private-path",
    authType: "auto", credentialConfigured: false, credentialSource: "oauth", credentialStatus: "unavailable", credentialMessage: "private-fixture-secret" },
    reload: { reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-secret"] } };
  assert.equal(JSON.stringify(publicMcpBearerRemoveResult(base)).includes("private"), false);
  for (const value of [null, {}, { ...base, auth: {} }, { ...base, reload: {} }]) assert.equal(publicMcpBearerRemoveResult(value), null);
});
