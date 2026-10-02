import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { prepareMcpConfigMigration } from "./mcp-config-validation.mjs";

const failed = (code) => ({ ok: false, issues: [{ code }], loadConfig: null });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readDocument(path, source, missingAllowed = false) {
  let bytes;
  try {
    if (!(await lstat(path)).isFile()) return failed(`${source}-not-regular-file`);
    bytes = await readFile(path);
  } catch (error) {
    if (missingAllowed && error?.code === "ENOENT") {
      return { ok: true, document: { mcpServers: {} }, sha256: null };
    }
    return failed(`${source}-unreadable`);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return failed(`${source}-invalid-encoding`); }
  try { return { ok: true, document: JSON.parse(text), sha256: sha256(bytes) }; }
  catch { return failed(`${source}-invalid-json`); }
}

/**
 * INTERNAL Backend preparation, not a WebUI endpoint or active runtime cutover.
 * Reads only explicit absolute owner paths, merges legacy defaults/overrides and
 * preflights the complete candidate through Pi's public SDK without a session.
 * Missing user config imports defaults DISABLED. Invalid/unsupported settings
 * reject the whole candidate, even for disabled servers. URL variables must be
 * supplied explicitly; command-valued env/headers/OAuth secrets remain unevaluated.
 *
 * The returned synchronous callback has the public McpExtensionOptions.loadConfig
 * shape and returns an independent clone on EVERY call. It ignores session cwd,
 * trust, project files and process.env. It is a captured snapshot, not a watcher:
 * owners must prepare a new callback on reload and recheck both source revisions
 * under the writer barrier before activation. Migration apply, serialized SDK
 * updateConfig, credential bridging and session binding remain separate steps.
 * Callback results contain private configs/paths: NEVER log or expose them.
 */
export async function prepareBackendMcpConfigLoader(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Object.keys(options).some((key) => !["agentDir", "bundledConfigPath", "urlVariables"].includes(key))
    || !Object.hasOwn(options, "agentDir") || typeof options.agentDir !== "string" || !isAbsolute(options.agentDir)
    || !Object.hasOwn(options, "bundledConfigPath") || typeof options.bundledConfigPath !== "string" || !isAbsolute(options.bundledConfigPath)) {
    return failed("invalid-loader-options");
  }
  const configPath = join(options.agentDir, "mcp.json");
  const bundled = await readDocument(options.bundledConfigPath, "bundled");
  if (!bundled.ok) return bundled;
  const user = await readDocument(configPath, "user", true);
  if (!user.ok) return user;
  const prepared = await prepareMcpConfigMigration(user.document, bundled.document, { urlVariables: Object.hasOwn(options, "urlVariables") ? options.urlVariables : {} });
  if (!prepared.ok) return { ok: false, issues: prepared.issues, loadConfig: null };
  const snapshot = {
    servers: Object.entries(prepared.config.mcpServers).map(([name, config]) => ({ name, config, source: configPath, scope: "global" })),
    ...(Object.hasOwn(prepared.config, "autoEnableCodemode") ? { autoEnableCodemode: prepared.config.autoEnableCodemode } : {}),
    errors: [],
  };
  return { ok: true, issues: [], sourceSha256: user.sha256, bundledSha256: bundled.sha256,
    serverCount: snapshot.servers.length, loadConfig: () => structuredClone(snapshot) };
}
