import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpBearerSaveRequest, publicMcpBearerSaveResult } from "./mcp-bearer-save-request.mjs";

test("bearer save parser accepts legacy aliases and emits only a normalized private request", () => {
  for (const selector of [{}, { type: "bearer" }, { action: "bearer" }, { type: "bearer", action: "bearer" }]) {
    const input = { ...selector, token: " private-fixture-token " };
    assert.deepEqual(parseMcpBearerSaveRequest(input), { ok: true, value: { type: "bearer", token: "private-fixture-token" } });
    assert.equal(input.token, " private-fixture-token ");
  }
  assert.equal(parseMcpBearerSaveRequest({ token: "x".repeat(8192) }).ok, true);
});

test("bearer save parser refuses invalid, inherited and privileged fields without echoing secrets", () => {
  for (const input of [null, [], {}, { token: " " }, { token: 123 }, { token: "x".repeat(8193) },
    { token: "x\r\ny" }, { token: "private-fixture-token", type: "headers" },
    { token: "private-fixture-token", type: "bearer", action: "remove" },
    ...["configPath", "agentDir", "headers", "input", "reload", "url"].map((key) => ({ token: "private-fixture-token", [key]: "other" })),
    Object.create({ token: "private-fixture-token" }), Object.assign(Object.create({ type: "bearer" }), { token: "private-fixture-token" })]) {
    assert.deepEqual(parseMcpBearerSaveRequest(input), { ok: false });
  }
});

test("bearer save response whitelist removes credentials, owner paths and provider/reload errors", () => {
  const input = { ok: true, token: "private-fixture-token", configPath: "owner-private-path",
    auth: { name: "fixture", configPath: "owner-private-path", authType: "bearer", credentialConfigured: true,
      credentialSource: "secure-store", credentialStatus: "present", token: "private-fixture-token", credentialMessage: "private-fixture-token" },
    reload: { reloaded: 1, deferred: 0, failed: 1, errors: ["private-fixture-token"] } };
  const result = publicMcpBearerSaveResult(input);
  assert.equal(result.auth.configPath, "");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.reload.errors.length, 1);
  for (const value of [null, {}, { ...input, ok: false }, { ...input, auth: { ...input.auth, authType: "headers" } },
    { ...input, auth: { ...input.auth, credentialSource: "config" } }, { ...input, reload: {} }]) {
    assert.equal(publicMcpBearerSaveResult(value), null);
  }
});
