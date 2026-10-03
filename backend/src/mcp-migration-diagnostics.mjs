import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Migration input only: this does not load the adapter or establish MCP connections.
const BUNDLED_CONFIG = new URL("../core/mcp-defaults.json", import.meta.url);
const applyPolicy = { applied: false, applyAvailable: false, applyBlockedReason: "configuration-writers-not-quiesced" };

/** Backend-owned dry-run. Options are internal deployment/test inputs, never request data. */
export async function readMcpMigrationDiagnostics({
  agentDir, bundledConfigPath = BUNDLED_CONFIG, urlVariables = process.env,
} = {}) {
  let bundledConfig;
  try {
    const bytes = await readFile(bundledConfigPath);
    bundledConfig = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, issues: [{ code: "bundled-config-unreadable" }], ...applyPolicy };
  }
  // Do not import the SDK on Backend startup: transport health must remain usable
  // while the runtime attaches. This creates neither a session nor a connection.
  const { migrateMcpConfigFile } = await import("../core/mcp-config-migration-file.mjs");
  const directory = agentDir ?? (await import("@earendil-works/pi-coding-agent")).getAgentDir();
  const result = await migrateMcpConfigFile({
    configPath: join(directory, "mcp.json"), bundledConfig, urlVariables, apply: false,
  });
  // Whitelist fields: do not accidentally expose credentials, paths or future
  // writer internals if the file primitive gains additional return properties.
  return {
    ok: result.ok,
    issues: result.issues.map(({ code, field, server }) => ({
      code, ...(field === undefined ? {} : { field }), ...(server === undefined ? {} : { server }),
    })),
    ...(result.ok ? { changed: result.changed, sourceSha256: result.sourceSha256, serverCount: result.serverCount } : {}),
    ...applyPolicy,
  };
}
