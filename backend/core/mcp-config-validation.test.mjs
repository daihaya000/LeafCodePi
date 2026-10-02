import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareMcpConfigMigration } from "./mcp-config-validation.mjs";

const local = { command: "fixture-server", args: ["--mcp"] };
const doc = (entry) => ({ mcpServers: { server: entry } });

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
