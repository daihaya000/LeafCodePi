import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpHeadersSaveRequest, publicMcpHeadersSaveResult } from "./mcp-headers-save-request.mjs";
const base = { type: "headers", headers: { "X-API-Key": "private-fixture-secret" } };

test("header parser trims/clones values and accepts legacy action aliases", () => {
  const input = { action: "headers", headers: { " X-API-Key ": " private-fixture-secret " } };
  const parsed = parseMcpHeadersSaveRequest(input);
  assert.deepEqual(parsed, { ok: true, value: base });
  assert.equal(input.headers[" X-API-Key "], " private-fixture-secret ");
  assert.notEqual(parsed.value.headers, input.headers);
  assert.equal(parseMcpHeadersSaveRequest({ type: "headers", headers: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`X-${i}`, "x".repeat(8192)])) }).ok, true);
});
test("header parser refuses invalid, duplicate, inherited and privileged fields without echoing values", () => {
  for (const input of [null, [], {}, { ...base, type: "oauth" }, { ...base, action: "bearer" }, { ...base, token: "private-fixture-secret" },
    { ...base, configPath: "other" }, { ...base, headers: {} }, { ...base, headers: [] },
    { ...base, headers: { "Bad Header": "private-fixture-secret" } }, { ...base, headers: { "X-Key": "a\nb" } },
    { ...base, headers: { "X-Key": "" } }, { ...base, headers: { "X-Key": 123 } },
    { ...base, headers: { "X-Key": "x".repeat(8193) } }, { ...base, headers: { "X-Key": "a", " x-key ": "b" } },
    { ...base, headers: { "X-Key": "\u2603" } }, { ...base, headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, "x"])) },
    { ...base, headers: Object.create({ Authorization: "private-fixture-secret" }) }, Object.create(base)]) {
    assert.deepEqual(parseMcpHeadersSaveRequest(input), { ok: false });
  }
});
test("prototype-like header names remain own properties rather than object mutations", () => {
  const input = { type: "headers", headers: JSON.parse('{"__proto__":"private-fixture-secret","constructor":"value"}') };
  const result = parseMcpHeadersSaveRequest(input);
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.value.headers), Object.prototype);
  assert.equal(Object.hasOwn(result.value.headers, "__proto__"), true);
  assert.equal(result.value.headers.__proto__, "private-fixture-secret");
});
test("header response strips secrets, paths and raw reload/provider errors", () => {
  const value = { ok: true, headers: base.headers,
    auth: { name: "fixture", configPath: "owner-private-path", authType: "headers", credentialConfigured: true,
      credentialSource: "secure-store", credentialStatus: "present", credentialMessage: "private-fixture-secret" },
    reload: { reloaded: 0, deferred: 0, failed: 1, errors: ["private-fixture-secret"] } };
  assert.equal(JSON.stringify(publicMcpHeadersSaveResult(value)).includes("private"), false);
  for (const input of [null, {}, { ...value, auth: { ...value.auth, authType: "none" } }, { ...value, auth: { ...value.auth, credentialSource: "oauth" } }, { ...value, reload: {} }]) {
    assert.equal(publicMcpHeadersSaveResult(input), null);
  }
  // A bearer-type status is the same redacted shape: a native headers save may coexist with an
  // Authorization header that the status reports first.
  assert.equal(publicMcpHeadersSaveResult({ ...value, auth: { ...value.auth, authType: "bearer", credentialSource: "config" } }).auth.authType, "bearer");
});
