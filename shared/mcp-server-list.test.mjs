import assert from "node:assert/strict";
import { test } from "node:test";
import { publicMcpServerList } from "./mcp-server-list.mjs";
const row = { id: "fixture", name: "fixture", enabled: true, bundled: false, userConfigured: true, source: "http",
  authType: "oauth", credentialConfigured: false, credentialSource: "oauth", credentialStatus: "unknown" };
test("list keeps only public flags/auth metadata and redacts every endpoint/path/credential field", () => {
  const input = { servers: [{ ...row, url: "https://private-user:private-password@example.invalid/mcp?key=private-key#private-fragment",
    command: "private-command", args: ["private-arg"], env: { TOKEN: "private-env" }, headers: { Authorization: "private-token" },
    oauth: { clientSecret: "private-secret" }, credentialMessage: "private-message" }], configPath: "private-path", bundledConfigPath: "private-bundled", token: "private-token" };
  const before = structuredClone(input);
  assert.deepEqual(publicMcpServerList(input), { servers: [{ ...row, url: "https://example.invalid/mcp" }], configPath: "", bundledConfigPath: null });
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(publicMcpServerList(input)).includes("private"), false);
  assert.deepEqual(publicMcpServerList({ servers: [] }), { servers: [], configPath: "", bundledConfigPath: null });
});
test("list omits invalid/templates/executable endpoints and all stdio URLs without evaluating them", () => {
  for (const url of ["!private-command", "${PRIVATE_URL}", "javascript:private-code", "not a URL", "file:///private-path"]) {
    assert.deepEqual(publicMcpServerList({ servers: [{ ...row, url }] }).servers, [row]);
  }
  assert.deepEqual(publicMcpServerList({ servers: [{ ...row, source: "stdio", url: "https://example.invalid" }] }).servers,
    [{ ...row, source: "stdio" }]);
});
test("list fails closed on malformed states, mismatched identities, duplicates and inherited data", () => {
  for (const value of [null, [], {}, { servers: {} }, Object.create({ servers: [] }), { servers: [null] }, { servers: [[]] },
    { servers: [row, row] }, { servers: [{ ...row, id: "other" }] }, { servers: [{ ...row, name: "" }] },
    { servers: [{ ...row, name: "fixture\n", id: "fixture\n" }] }, { servers: [{ ...row, enabled: "true" }] },
    { servers: [{ ...row, bundled: 0 }] }, { servers: [{ ...row, userConfigured: undefined }] }, { servers: [{ ...row, source: "sse" }] },
    { servers: [{ ...row, authType: "private-secret" }] }, { servers: [{ ...row, credentialStatus: "invalid" }] },
    { servers: [{ ...row, credentialSource: "invalid" }] }, { servers: [{ ...row, credentialConfigured: 1 }] },
    { servers: [Object.create(row)] }]) assert.equal(publicMcpServerList(value), null);
});
test("prototype-like own identities and null-prototype data remain safe", () => {
  for (const name of ["__proto__", "constructor"]) {
    const server = Object.assign(Object.create(null), row, { name, id: name });
    assert.equal(publicMcpServerList(Object.assign(Object.create(null), { servers: [server] })).servers[0].name, name);
  }
});
