import assert from "node:assert/strict";
import { test } from "node:test";
import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";
const base = { name: "fixture", authType: "bearer", credentialConfigured: true,
  credentialSource: "secure-store", credentialStatus: "present" };
test("auth DTO strips credential fields, paths and messages and redacts the URL", () => {
  const result = publicMcpAuthSnapshot({ ...base, configPath: "owner-private-path", token: "private-fixture-secret",
    credentialMessage: "private-fixture-secret", headers: { Authorization: "private-fixture-secret" },
    url: "https://user:password@example.invalid/mcp?token=private-fixture-secret#private" });
  assert.deepEqual(result, { ...base, configPath: "", url: "https://example.invalid/mcp" });
});
test("malformed auth states fail closed and invalid URLs do not escape", () => {
  for (const value of [null, {}, { ...base, credentialStatus: "private-fixture-secret" },
    { ...base, credentialSource: "invalid" }, { ...base, authType: "invalid" }, { ...base, credentialConfigured: "true" }]) {
    assert.equal(publicMcpAuthSnapshot(value), null);
  }
  assert.deepEqual(publicMcpAuthSnapshot({ ...base, url: "private-fixture-secret" }), { ...base, configPath: "" });
});
