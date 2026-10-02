import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpOAuthStartRequest, publicMcpOAuthStartResult } from "./mcp-oauth-start-request.mjs";

test("OAuth start requires an explicit selector and normalizes its default action", () => {
  for (const input of [{ type: "oauth" }, { type: "oauth", action: "start" }]) {
    assert.deepEqual(parseMcpOAuthStartRequest(input), { ok: true, value: { type: "oauth", action: "start" } });
  }
  for (const input of [null, [], {}, { action: "start" }, { type: "oauth", action: "complete" }, { type: "oauth", token: "private-secret" },
    { type: "oauth", input: "private-secret" }, { type: "oauth", configPath: "private-path" }, Object.create({ type: "oauth" }),
    Object.assign(Object.create({ action: "start" }), { type: "oauth" })]) {
    assert.deepEqual(parseMcpOAuthStartRequest(input), { ok: false });
  }
});
test("OAuth start publishes only the server, flow status and functional authorization URL", () => {
  const authorizationUrl = "https://id.example.invalid/authorize?client_id=fixture&state=public-state&code_challenge=public-challenge&response_type=code";
  const result = publicMcpOAuthStartResult({ ok: true, name: "fixture", status: "pending", authorizationUrl,
    token: "private-secret", configPath: "private-path", error: "private-message" });
  assert.deepEqual(result, { ok: true, name: "fixture", status: "pending", authorizationUrl });
  assert.deepEqual(publicMcpOAuthStartResult({ ok: true, name: "fixture", status: "authenticated" }), { ok: true, name: "fixture", status: "authenticated" });
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.ok(publicMcpOAuthStartResult({ ok: true, name: "fixture", status: "pending", authorizationUrl: `http://${host}:8181/authorize?state=public` }));
  }
});
test("OAuth start rejects unsafe credential-bearing URLs and malformed flow states", () => {
  const base = { ok: true, name: "fixture", status: "pending" };
  for (const authorizationUrl of ["javascript:alert(1)", "file:///private", "http://id.example.invalid/authorize", "https://user:private@id.example.invalid/authorize",
    "https://id.example.invalid/authorize#private", "https://id.example.invalid/authorize?client_secret=private", "https://id.example.invalid/authorize?ACCESS_TOKEN=private",
    "https://id.example.invalid/authorize?code_verifier=private", "https://id.example.invalid/callback?code=private", "https://id.example.invalid/\nprivate", "x".repeat(16385)]) {
    assert.equal(publicMcpOAuthStartResult({ ...base, authorizationUrl }), null);
  }
  for (const value of [null, {}, { ...base, authorizationUrl: "" }, { ...base, status: "unknown" }, { ...base, name: "a/b" },
    { ...base, name: "other..path" }, { ...base, name: " fixture" }, { ...base, name: "fixture\u0000" },
    { ...base, status: "authenticated", authorizationUrl: "https://id.example.invalid/authorize" }]) assert.equal(publicMcpOAuthStartResult(value), null);
});
