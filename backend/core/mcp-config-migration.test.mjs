import assert from "node:assert/strict";
import { test } from "node:test";
import { planMcpConfigMigration } from "./mcp-config-migration.mjs";

const document = (entry) => ({ mcpServers: { server: entry } });
const stdio = { command: "test-server", args: ["--mcp"] };

test("maps both disabled states without silently enabling a disabled server", () => {
  for (const disabled of [true, false]) {
    const result = planMcpConfigMigration(document({ ...stdio, disabled }));
    assert.equal(result.ok, true);
    assert.equal(result.config.mcpServers.server.enabled, !disabled);
    assert.equal(Object.hasOwn(result.config.mcpServers.server, "disabled"), false);
  }
});

test("preserves transport, credentials references and modern provider auth verbatim", () => {
  const input = { mcpServers: {
    local: { ...stdio, cwd: "C:\\tools", env: { KEY: "!read-key", HOST: "${HOST}" } },
    remote: { url: "https://example.invalid/mcp", auth: { provider: "example" },
      headers: { "x-token": "${TOKEN}" }, oauth: { clientName: "Pi", authServerMetadataUrl: "https://example.invalid/meta" },
      enabled: false, exposure: "hidden", timeout: 120, description: "Test server" },
  }, autoEnableCodemode: false };
  const before = structuredClone(input);
  const result = planMcpConfigMigration(input);
  assert.deepEqual(result.config, input);
  assert.deepEqual(input, before);
  result.config.mcpServers.local.env.KEY = "changed";
  assert.equal(input.mcpServers.local.env.KEY, "!read-key");
});

test("removes only supported legacy OAuth and transport markers", () => {
  const result = planMcpConfigMigration(document({ url: "https://example.invalid/mcp",
    auth: "oauth", protocolVersion: "auto", httpTransport: "streamable-http", oauth: { clientId: "${CLIENT_ID}" } }));
  assert.deepEqual(result.config, document({ url: "https://example.invalid/mcp", oauth: { clientId: "${CLIENT_ID}" } }));
});

test("resolves partial disabled overrides against bundled server definitions", () => {
  const defaults = { mcpServers: {
    slack: { url: "https://example.invalid/mcp", auth: "oauth" },
    browser: stdio,
  } };
  const input = { mcpServers: { slack: { disabled: true } } };
  const result = planMcpConfigMigration(input, defaults);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.mcpServers.slack, { url: "https://example.invalid/mcp", enabled: false });
  assert.deepEqual(result.config.mcpServers.browser, { ...stdio, enabled: false });
  assert.equal(Object.hasOwn(defaults.mcpServers.slack, "disabled"), false);
});

test("explicit user entries retain their enabled state instead of inheriting the import policy", () => {
  const result = planMcpConfigMigration(document({ args: ["--user"] }), document(stdio));
  assert.deepEqual(result.config, document({ command: "test-server", args: ["--user"] }));
});

test("native and legacy user state each override inherited state", () => {
  const native = planMcpConfigMigration(document({ enabled: true }), document({ ...stdio, disabled: true }));
  assert.equal(native.ok, true);
  assert.equal(native.config.mcpServers.server.enabled, true);
  const legacy = planMcpConfigMigration(document({ disabled: true }), document({ ...stdio, enabled: true }));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.config.mcpServers.server.enabled, false);
});

test("normalizes codemode aliases including per-tool overrides", () => {
  const result = planMcpConfigMigration(document({ ...stdio, exposure: "codemode-deferred",
    toolExposure: { read: "codemode-deferred", remove: "hidden" } }));
  assert.equal(result.config.mcpServers.server.exposure, "codemode");
  assert.deepEqual(result.config.mcpServers.server.toolExposure, { read: "codemode", remove: "hidden" });
});

test("planning is idempotent, including imported defaults", () => {
  const defaults = document({ ...stdio, disabled: false, protocolVersion: "auto" });
  const first = planMcpConfigMigration({ mcpServers: {} }, defaults);
  const second = planMcpConfigMigration(first.config, defaults);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
});

test("refuses unsupported settings without leaking their values or a partial config", () => {
  const secret = "secret-fixture-do-not-log";
  const input = { mcpServers: { server: { ...stdio, bearerStore: { token: secret } } }, imports: [secret] };
  const result = planMcpConfigMigration(input);
  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["unsupported-root-field", "unsupported-server-field"]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("refuses legacy SSE, pinned protocol and unsupported auth rather than dropping behavior", () => {
  for (const extra of [{ type: "sse" }, { httpTransport: "sse" }, { protocolVersion: "2024-11-05" }, { auth: "bearer" }]) {
    const result = planMcpConfigMigration(document({ url: "https://example.invalid/mcp", ...extra }));
    assert.equal(result.ok, false);
    assert.equal(result.config, null);
  }
});

test("refuses malformed documents, entries and flags", () => {
  for (const input of [null, [], { mcpServers: [] }, document(null), document([]),
    document({ ...stdio, disabled: "true" }), document({ ...stdio, enabled: 1 }),
    { ...document(stdio), autoEnableCodemode: "false" }]) {
    assert.equal(planMcpConfigMigration(input).ok, false);
  }
  assert.equal(planMcpConfigMigration({}, null).ok, false);
});

test("refuses conflicting flags within one server entry", () => {
  for (const flags of [{ enabled: true, disabled: true }, { enabled: false, disabled: false }]) {
    assert.equal(planMcpConfigMigration(document({ ...stdio, ...flags })).ok, false);
  }
});

test("refuses names that collide after Pi namespace normalization", () => {
  const result = planMcpConfigMigration({ mcpServers: { "my-server": stdio, my_server: stdio } });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "namespace-collision");
  assert.equal(planMcpConfigMigration({ mcpServers: { "bad/name": stdio } }).ok, false);
});

test("prototype-like server names remain own data properties", () => {
  const input = JSON.parse('{"mcpServers":{"__proto__":{"command":"test"},"constructor":{"command":"test"}}}');
  const result = planMcpConfigMigration(input);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.config.mcpServers, "__proto__"), true);
  assert.equal(result.config.mcpServers.__proto__.command, "test");
  assert.equal(Object.getPrototypeOf(result.config.mcpServers), Object.prototype);
});
