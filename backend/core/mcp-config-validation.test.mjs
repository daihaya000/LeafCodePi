import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planMcpConfigMigration } from "./mcp-config-migration.mjs";
import { prepareMcpConfigMigration } from "./mcp-config-validation.mjs";

const local = { command: "fixture-server", args: ["--mcp"] };
const doc = (entry) => ({ mcpServers: { server: entry } });

test("the shipped preset shapes migrate: n8n/slack/notion pass, google-workspace scopes convert and refuse", async () => {
  // Exactly what web/src/lib/mcp.ts writes for each preset.
  const presets = {
    n8n: { url: "https://n8n.example.invalid/mcp-server/http", auth: "oauth", httpTransport: "streamable-http", protocolVersion: "auto" },
    slack: { url: "https://mcp.slack.com/mcp", auth: "oauth", httpTransport: "streamable-http", protocolVersion: "auto", oauth: { clientId: "fixture-client-id" } },
    notion: { url: "https://mcp.notion.com/mcp", auth: "oauth", protocolVersion: "auto" },
    gws: { url: "https://gmail.googleapis.com/mcp/v1", auth: "oauth", httpTransport: "streamable-http", protocolVersion: "auto",
      oauth: { clientId: "fixture-client-id", clientSecret: "fixture-client-secret", scopes: ["gmail.readonly", "gmail.send"], authorizationParams: { access_type: "offline" } } },
  };
  for (const name of ["n8n", "slack", "notion"]) {
    const result = await prepareMcpConfigMigration({ mcpServers: { [name]: presets[name] } });
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.issues)}`);
    assert.equal(Object.hasOwn(result.config.mcpServers[name], "auth"), false);
  }
  // Scopes convert to the SDK's single space-separated field; extra authorization params refuse.
  const scopes = planMcpConfigMigration({ mcpServers: { gws: { ...presets.gws, oauth: { ...presets.gws.oauth, authorizationParams: undefined } } } });
  assert.equal(scopes.ok, true);
  assert.equal(scopes.config.mcpServers.gws.oauth.scope, "gmail.readonly gmail.send");
  const refused = planMcpConfigMigration({ mcpServers: { gws: presets.gws } });
  assert.equal(refused.ok, false);
  assert.equal(refused.issues.some((issue) => issue.code === "unsupported-oauth-authorization-params"), true);
  for (const oauth of [{ scopes: [] }, { scopes: [""] }, { scopes: [1] }, { scope: "a", scopes: ["b"] }]) {
    const bad = planMcpConfigMigration({ mcpServers: { server: { url: "https://example.invalid/mcp", oauth } } });
    assert.equal(bad.ok, false);
  }
});

test("preflight composes conversion and actual SDK validation without mutating input", async () => {
  const input = { ...doc({ ...local, disabled: true, exposure: "codemode-deferred", env: { KEY: "!read-key" } }),
    autoEnableCodemode: false };
  const before = structuredClone(input);
  const result = await prepareMcpConfigMigration(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { ...doc({ ...local, enabled: false, exposure: "codemode", env: { KEY: "!read-key" } }),
    autoEnableCodemode: false });
  assert.deepEqual(input, before);
  result.config.mcpServers.server.args.push("changed");
  assert.deepEqual(input.mcpServers.server.args, ["--mcp"]);
});

test("resolves a disabled bundled URL only from the explicitly supplied variables", async () => {
  const input = doc({ disabled: true });
  const defaults = doc({ url: "${ENDPOINT}/mcp", auth: "oauth", protocolVersion: "auto" });
  const result = await prepareMcpConfigMigration(input, defaults, { urlVariables: { ENDPOINT: "https://example.invalid" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, doc({ url: "https://example.invalid/mcp", enabled: false }));
  assert.deepEqual(input, doc({ disabled: true }));
  assert.equal(defaults.mcpServers.server.url, "${ENDPOINT}/mcp");
});

test("missing, empty, inherited and recursively templated URL values refuse the whole plan", async () => {
  const input = doc({ url: "${ENDPOINT}", disabled: true });
  for (const urlVariables of [{}, { ENDPOINT: "" }, { ENDPOINT: " " }, { ENDPOINT: 42 },
    Object.create({ ENDPOINT: "https://example.invalid/mcp" }), { ENDPOINT: "${OTHER}" }]) {
    const result = await prepareMcpConfigMigration(input, undefined, { urlVariables });
    assert.deepEqual(result, { ok: false, config: null,
      issues: [{ code: "unresolved-url-variable", field: "url", server: "server" }] });
  }
  assert.equal((await prepareMcpConfigMigration(doc({ url: "${BAD-NAME}" }))).ok, false);
});

test("does not resolve a URL implicitly from process.env", async (t) => {
  const previous = process.env.LEAFCODE_MCP_TEST_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.LEAFCODE_MCP_TEST_URL;
    else process.env.LEAFCODE_MCP_TEST_URL = previous;
  });
  process.env.LEAFCODE_MCP_TEST_URL = "https://example.invalid/mcp";
  const result = await prepareMcpConfigMigration(doc({ url: "${LEAFCODE_MCP_TEST_URL}" }));
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "unresolved-url-variable");
});

test("a disabled shipped default with an unresolved URL is dropped; user-owned or enabled ones still refuse", async () => {
  const bundled = { mcpServers: { n8n: { url: "${N8N_MCP_URL}", auth: "oauth", disabled: true } } };
  // The user only disables the shipped n8n entry (the real LeafCodePi layout): the URL stays bundled.
  const overridden = await prepareMcpConfigMigration({ mcpServers: { n8n: { disabled: true }, keep: local } }, bundled, { urlVariables: {} });
  assert.equal(overridden.ok, true);
  assert.deepEqual(Object.keys(overridden.config.mcpServers), ["keep"]);
  assert.deepEqual(bundled, { mcpServers: { n8n: { url: "${N8N_MCP_URL}", auth: "oauth", disabled: true } } });
  // Absent from the user's document entirely: same drop.
  const bundledOnly = await prepareMcpConfigMigration({ mcpServers: {} }, bundled, { urlVariables: {} });
  assert.equal(bundledOnly.ok, true); assert.deepEqual(Object.keys(bundledOnly.config.mcpServers), []);
  // A user-owned URL must be resolved by the user, even when the entry is disabled.
  const ownUrl = await prepareMcpConfigMigration(doc({ url: "${USER_URL}", disabled: true }), undefined, { urlVariables: {} });
  assert.deepEqual(ownUrl.issues, [{ code: "unresolved-url-variable", field: "url", server: "server" }]);
  // The user disables a shipped entry but pins their own URL: still the user's to resolve.
  const ownOverride = await prepareMcpConfigMigration({ mcpServers: { n8n: { disabled: true, url: "${USER_URL}" } } }, bundled, { urlVariables: {} });
  assert.deepEqual(ownOverride.issues, [{ code: "unresolved-url-variable", field: "url", server: "n8n" }]);
  // An enabled shipped default cannot be dropped: the user asked for it, so it must resolve.
  const enabled = await prepareMcpConfigMigration({ mcpServers: { shipped: { enabled: true } } }, { mcpServers: { shipped: { url: "${SHIPPED_URL}" } } }, { urlVariables: {} });
  assert.deepEqual(enabled.issues, [{ code: "unresolved-url-variable", field: "url", server: "shipped" }]);
  // Supplying the variable keeps the shipped default instead of dropping it.
  const supplied = await prepareMcpConfigMigration({ mcpServers: {} }, bundled, { urlVariables: { N8N_MCP_URL: "https://n8n.example.invalid/mcp" } });
  assert.equal(supplied.ok, true); assert.deepEqual(supplied.config.mcpServers.n8n, { url: "https://n8n.example.invalid/mcp", enabled: false });
});

test("a migrated bearer entry validates through the SDK with an explicit variable", async () => {
  const result = await prepareMcpConfigMigration({ mcpServers: { n8n: { url: "${N8N_MCP_URL}", auth: "bearer", bearerTokenEnv: "N8N_MCP_ACCESS_TOKEN" } } }, undefined, { urlVariables: { N8N_MCP_URL: "https://n8n.example.invalid/mcp" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.mcpServers.n8n, { url: "https://n8n.example.invalid/mcp", headers: { Authorization: "Bearer ${N8N_MCP_ACCESS_TOKEN}" } });
});

test("real SDK failures return no partial configuration or credential values", async () => {
  const credential = "secret-fixture-not-for-diagnostics";
  const result = await prepareMcpConfigMigration({ mcpServers: {
    valid: local,
    bad: { url: "https://example.invalid/mcp", headers: { Authorization: credential }, oauth: { callbackPort: 0 } },
  } });
  assert.deepEqual(result, { ok: false, config: null,
    issues: [{ code: "sdk-invalid-server", field: "mcpServers", server: "bad" }] });
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test("accepts provider auth and rejects a non-HTTPS remote provider endpoint", async () => {
  const good = await prepareMcpConfigMigration(doc({ url: "https://example.invalid/mcp", auth: { provider: "fixture" } }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.config.mcpServers.server.auth, { provider: "fixture" });
  const bad = await prepareMcpConfigMigration(doc({ url: "http://example.invalid/mcp", auth: { provider: "fixture" } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.issues[0].code, "sdk-invalid-server");
});

test("refuses unsupported legacy behavior and malformed variable maps", async () => {
  const unsupported = await prepareMcpConfigMigration(doc({ ...local, httpTransport: "sse" }));
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.issues[0].code, "unsupported-transport");
  for (const urlVariables of [null, [], 42]) {
    const result = await prepareMcpConfigMigration(doc(local), undefined, { urlVariables });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, "invalid-url-variables");
  }
});

test("preflight is idempotent and keeps an empty server list valid", async () => {
  const first = await prepareMcpConfigMigration(doc({ ...local, disabled: false }));
  assert.equal(first.ok, true);
  assert.deepEqual(await prepareMcpConfigMigration(first.config), first);
  assert.deepEqual(await prepareMcpConfigMigration({ mcpServers: {} }), { ok: true, issues: [], config: { mcpServers: {} } });
});

test("preflight never executes submitted commands, including URL-command substitutions", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-mcp-command-probe-"));
  try {
    const marker = join(root, "executed");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`;
    const command = `!${process.execPath} -e ${JSON.stringify(script)}`;
    const valid = await prepareMcpConfigMigration(doc({ command: process.execPath, args: ["-e", script], env: { KEY: command } }));
    assert.equal(valid.ok, true);
    const rejected = await prepareMcpConfigMigration(doc({ url: "${ENDPOINT}" }), undefined, { urlVariables: { ENDPOINT: command } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues[0].code, "unsupported-url-command");
    assert.equal(JSON.stringify(rejected).includes(script), false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
