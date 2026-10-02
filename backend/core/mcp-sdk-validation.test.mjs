import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { planMcpConfigMigration } from "./mcp-config-migration.mjs";

/**
 * Exercise only public SDK APIs in an isolated agent directory. No session is
 * created or bound, so registration validates but does not connect MCP servers,
 * expand environment/command references, or read the user's credentials.
 */
async function withRegistration(factory, verify) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-mcp-validation-"));
  try {
    let loadedApi;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => { loadedApi = pi; factory(pi, root); }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    // Registration changes are committed only after the factory succeeds.
    await verify(root, loadedApi);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const local = { command: "fixture-mcp-server", args: ["--mcp"] };

test("real SDK accepts migrated stdio, OAuth and provider-auth configurations", async () => {
  const input = { autoEnableCodemode: false, mcpServers: {
    local: { ...local, env: { KEY: "${FIXTURE_TOKEN}" }, disabled: true, exposure: "codemode-deferred" },
    oauth: { url: "https://example.invalid/mcp", auth: "oauth", protocolVersion: "auto",
      httpTransport: "streamable-http", oauth: { clientId: "fixture", clientName: "Pi",
        authServerMetadataUrl: "https://example.invalid/.well-known/openid-configuration" },
      toolExposure: { read: "codemode-deferred", delete: "hidden" } },
    provider: { url: "https://example.invalid/provider", auth: { provider: "fixture-provider" } },
  } };
  const original = structuredClone(input);
  const plan = planMcpConfigMigration(input);
  assert.equal(plan.ok, true);
  await withRegistration((pi) => {
    for (const [name, config] of Object.entries(plan.config.mcpServers)) pi.registerMcpServer(name, config);
  }, (_root, pi) => {
    const registered = Object.fromEntries(pi.getMcpServers().map(({ name, config }) => [name, config]));
    assert.deepEqual(registered, plan.config.mcpServers);
    assert.equal(registered.local.enabled, false);
    assert.equal(registered.local.exposure, "codemode");
    assert.deepEqual(input, original);
  });
});

test("real SDK rejects malformed migrated settings before any connection", async () => {
  const invalid = [
    { args: [42] },
    { env: { KEY: 42 } },
    { timeout: 0 },
    { exposure: "unknown" },
    { url: "not-a-url" },
    { url: "https://example.invalid/mcp", headers: { token: 42 } },
    { url: "https://example.invalid/mcp", oauth: { callbackPort: 0 } },
    { url: "https://example.invalid/mcp", oauth: { callbackUrl: "https://example.invalid/callback" } },
    { url: "http://example.invalid/mcp", auth: { provider: "fixture-provider" } },
  ];
  await withRegistration((pi) => {
    for (const [index, extra] of invalid.entries()) {
      const plan = planMcpConfigMigration({ mcpServers: { server: { ...local, ...extra } } });
      assert.equal(plan.ok, true, "Structural migration is deliberately not SDK validation");
      assert.throws(() => pi.registerMcpServer(`invalid_${index}`, plan.config.mcpServers.server));
    }
    assert.deepEqual(pi.getMcpServers(), []);
  }, () => {});
});

test("bundled URL placeholders still need resolution even for disabled servers", async () => {
  const plan = planMcpConfigMigration({ mcpServers: { n8n: { disabled: true } } }, {
    mcpServers: { n8n: { url: "${N8N_MCP_URL}", auth: "oauth", httpTransport: "streamable-http" } },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.config.mcpServers.n8n.enabled, false);
  await withRegistration((pi) => {
    assert.throws(() => pi.registerMcpServer("n8n", plan.config.mcpServers.n8n));
    assert.deepEqual(pi.getMcpServers(), []);
  }, () => {});
});

test("SDK registration does not launch a stdio process or execute an env command", async () => {
  await withRegistration((pi, root) => {
    const marker = join(root, "command-executed");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`;
    pi.registerMcpServer("side_effect_probe", {
      command: process.execPath,
      args: ["-e", script],
      env: { KEY: `!${process.execPath} -e ${JSON.stringify(script)}` },
    });
  }, (root, pi) => {
    assert.equal(pi.getMcpServers().length, 1);
    assert.equal(existsSync(join(root, "command-executed")), false);
    assert.equal(existsSync(join(root, "mcp-auth.json")), false);
  });
});

test("real SDK detects hyphen/underscore namespace collisions and clones registrations", async () => {
  await withRegistration((pi) => {
    const config = structuredClone(local);
    pi.registerMcpServer("my-server", config);
    config.args.push("--changed-after-registration");
  }, (_root, pi) => {
    assert.throws(() => pi.registerMcpServer("my_server", local));
    const registered = pi.getMcpServers();
    assert.deepEqual(registered[0].config.args, ["--mcp"]);
    registered[0].config.args.push("--changed-snapshot");
    assert.deepEqual(pi.getMcpServers()[0].config.args, ["--mcp"]);
  });
});
