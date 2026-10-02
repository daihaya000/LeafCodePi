import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { planMcpConfigMigration } from "./mcp-config-migration.mjs";

const failed = (issues) => ({ ok: false, issues, config: null });
const issue = (code, field = "mcpServers", server) => ({ code, field, ...(server === undefined ? {} : { server }) });

/**
 * Backend-only migration preflight: structural conversion, explicit URL-variable
 * substitution, then validation through Pi's public extension API. No session,
 * network connection, credential access, env-command execution or config write.
 * The temporary SDK directory contains no submitted configuration and is removed.
 * Success config may contain secrets: it is for the internal writer, NOT a WebUI
 * response. Failure diagnostics intentionally omit SDK messages and input values.
 * urlVariables is explicit; process.env is never read implicitly for expansion.
 * A disabled bundled default whose URL the user never configured is dropped (unreachable anyway);
 * user-owned or enabled templates still refuse the whole candidate.
 */
export async function prepareMcpConfigMigration(
  userConfig,
  bundledConfig = { mcpServers: {} },
  { urlVariables = {} } = {},
) {
  const plan = planMcpConfigMigration(userConfig, bundledConfig);
  if (!plan.ok) return plan;
  if (!urlVariables || typeof urlVariables !== "object" || Array.isArray(urlVariables)) {
    return failed([issue("invalid-url-variables", "urlVariables")]);
  }
  const issues = [];
  // Provenance for the scoped drop below: a URL that only the bundled document defines is a shipped
  // default, not something this user configured.
  const userServers = userConfig && typeof userConfig === "object" && !Array.isArray(userConfig)
    && userConfig.mcpServers && typeof userConfig.mcpServers === "object" && !Array.isArray(userConfig.mcpServers)
    ? userConfig.mcpServers : undefined;
  const userDefinedUrl = (name) => {
    const entry = userServers && Object.hasOwn(userServers, name) ? userServers[name] : undefined;
    return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && typeof entry.url === "string";
  };
  for (const [name, server] of Object.entries(plan.config.mcpServers)) {
    if (typeof server.url !== "string") continue;
    let missing = false;
    server.url = server.url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, variable) => {
      const value = Object.hasOwn(urlVariables, variable) ? urlVariables[variable] : undefined;
      if (typeof value !== "string" || !value.trim()) {
        missing = true;
        return reference;
      }
      return value;
    });
    if (missing || server.url.includes("${")) {
      // A disabled shipped default whose URL the user never configured cannot be reached anyway:
      // dropping it keeps the rest of the config usable. User-owned URLs and enabled servers still
      // refuse, so an unreachable-but-wanted server is never silently activated or rewritten.
      if (!userDefinedUrl(name) && server.enabled === false) { delete plan.config.mcpServers[name]; continue; }
      issues.push(issue("unresolved-url-variable", "url", name));
    } else if (server.url.startsWith("!")) issues.push(issue("unsupported-url-command", "url", name));
  }
  // Never drop or activate an invalid disabled server to make validation pass, except for the
  // bundled-default case above.
  if (issues.length) return failed(issues);

  let root;
  let result;
  try {
    root = await mkdtemp(join(tmpdir(), "leafcode-mcp-preflight-"));
    let api;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        api = pi;
        for (const [name, config] of Object.entries(plan.config.mcpServers)) {
          try {
            pi.registerMcpServer(name, config);
          } catch {
            issues.push(issue("sdk-invalid-server", "mcpServers", name));
          }
        }
      }],
    });
    await loader.reload();
    if (loader.getExtensions().errors.length || !api) {
      result = failed([issue("sdk-loader-failed")]);
    } else if (issues.length) {
      result = failed(issues);
    } else {
      // Registrations are applied after the factory completes, not inside it.
      const entries = api.getMcpServers().map(({ name, config }) => [name, config]);
      if (entries.length !== Object.keys(plan.config.mcpServers).length) {
        result = failed([issue("sdk-registration-incomplete")]);
      } else {
        result = { ok: true, issues: [], config: { ...plan.config, mcpServers: Object.fromEntries(entries) } };
      }
    }
  } catch {
    result = failed([issue("sdk-loader-failed")]);
  } finally {
    if (root) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        result = failed([issue("sdk-cleanup-failed")]);
      }
    }
  }
  return result;
}
