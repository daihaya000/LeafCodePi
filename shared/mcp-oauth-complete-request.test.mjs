import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpOAuthCompleteRequest, publicMcpOAuthCompleteResult } from "./mcp-oauth-complete-request.mjs";
const request = { type: "oauth", action: "complete", input: "private-code" };
const auth = { name: "fixture", authType: "oauth", credentialConfigured: true, credentialSource: "oauth", credentialStatus: "present", configPath: "private-path" };
const reload = { reloaded: 1, deferred: 0, failed: 1, errors: ["private-secret"] };
test("OAuth completion normalizes a private callback URL/code without mutating input", () => {
  for (const input of [" private-code ", " http://127.0.0.1:8181/callback?code=private-code&state=private-state ", "x".repeat(16384)]) {
    const body = { ...request, input };
    assert.deepEqual(parseMcpOAuthCompleteRequest(body), { ok: true, value: { ...request, input: input.trim() } });
    assert.equal(body.input, input);
  }
});
test("OAuth completion rejects malformed, inherited, conflicting and privileged fields", () => {
  for (const body of [null, [], {}, { ...request, input: "" }, { ...request, input: "x".repeat(16385) }, { ...request, input: "private\ncode" },
    { ...request, input: "private\u0000code" }, { ...request, action: "start" }, { ...request, token: "private" }, { ...request, configPath: "other" },
    Object.create(request), Object.assign(Object.create({ action: "complete" }), { type: "oauth", input: "private" })]) {
    assert.deepEqual(parseMcpOAuthCompleteRequest(body), { ok: false });
  }
});
test("OAuth completion publishes only whitelisted status/auth/reload fields", () => {
  for (const status of ["authenticated", "expired", "not_authenticated"]) {
    const result = publicMcpOAuthCompleteResult({ ok: true, status, auth, reload, input: "private-code", token: "private-token", error: "private-error" });
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
  for (const value of [null, {}, { ok: true, status: "pending", auth, reload },
    { ok: true, status: "authenticated", auth: { ...auth, authType: "bearer" }, reload },
    { ok: true, status: "authenticated", auth, reload: { reloaded: -1 } }]) assert.equal(publicMcpOAuthCompleteResult(value), null);
});
