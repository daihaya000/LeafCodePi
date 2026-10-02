/**
 * Pure migration planning for the adapter's mcp.json. No I/O, command execution,
 * variable expansion, or credential access. Callers must validate with Pi before
 * writing a backup and applying the result. Issues contain field names, not values.
 */
const ROOT_FIELDS = new Set(["mcpServers", "autoEnableCodemode"]);
const SERVER_FIELDS = new Set([
  "type", "command", "args", "env", "cwd", "url", "headers", "oauth", "auth",
  "bearerToken", "bearerTokenEnv",
  "exposure", "toolExposure", "description", "enabled", "timeout",
  "disabled", "protocolVersion", "httpTransport",
]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

/**
 * User entries shallow-override bundled entries, matching the legacy loader.
 * Defaults absent from the user file are imported disabled: migration never
 * starts a previously implicit/default server without an explicit user entry.
 * Any unsupported conversion refuses the whole plan; inputs are never changed.
 * A successful plan is NOT a substitute for Pi's full configuration validation.
 */
export function planMcpConfigMigration(userConfig, bundledConfig = { mcpServers: {} }) {
  const issues = [];
  const issue = (code, field, server) => issues.push({ code, field, ...(server === undefined ? {} : { server }) });
  const serversOf = (document, source) => {
    if (!record(document)) {
      issue("invalid-document", source);
      return {};
    }
    for (const key of Object.keys(document)) {
      if (!ROOT_FIELDS.has(key)) issue("unsupported-root-field", key);
    }
    if (own(document, "autoEnableCodemode") && typeof document.autoEnableCodemode !== "boolean") {
      issue("invalid-boolean", "autoEnableCodemode");
    }
    if (own(document, "mcpServers") && !record(document.mcpServers)) {
      issue("invalid-server-map", "mcpServers");
      return {};
    }
    return document.mcpServers ?? {};
  };
  const defaults = serversOf(bundledConfig, "bundled");
  const overrides = serversOf(userConfig, "user");
  const names = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
  const namespaces = new Set();
  const entries = [];
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) issue("invalid-server-name", "mcpServers", name);
    const namespace = name.replaceAll("-", "_");
    if (namespaces.has(namespace)) issue("namespace-collision", "mcpServers", name);
    namespaces.add(namespace);
    const hasOverride = own(overrides, name);
    const base = own(defaults, name) ? defaults[name] : {};
    const override = hasOverride ? overrides[name] : {};
    if (!record(base) || !record(override)) {
      issue("invalid-server-entry", "mcpServers", name);
      continue;
    }
    const entry = structuredClone({ ...base, ...override });
    // A user flag in either dialect supersedes the inherited flag in the other.
    if (own(override, "enabled") && !own(override, "disabled")) delete entry.disabled;
    if (own(override, "disabled") && !own(override, "enabled")) delete entry.enabled;
    for (const field of Object.keys(entry)) {
      if (!SERVER_FIELDS.has(field)) issue("unsupported-server-field", field, name);
    }
    for (const field of ["disabled", "enabled"]) {
      if (own(entry, field) && typeof entry[field] !== "boolean") issue("invalid-boolean", field, name);
    }
    if (own(entry, "disabled")) {
      const enabled = !entry.disabled;
      if (own(entry, "enabled") && entry.enabled !== enabled) issue("conflicting-enabled-state", "enabled", name);
      else entry.enabled = enabled;
      delete entry.disabled;
    }
    if (!hasOverride) entry.enabled = false;
    // Native has no auth mode: a static bearer token becomes an Authorization header, so legacy
    // `auth: "bearer"` entries (including the shipped n8n preset) keep working after migration.
    // Non-string auth (the SDK's provider object) is passed through untouched, as before.
    if (own(entry, "auth") && typeof entry.auth === "string") {
      const mode = entry.auth;
      if (mode === "oauth") { delete entry.auth; }
      else if (mode === "bearer") {
        const envName = own(entry, "bearerTokenEnv") ? entry.bearerTokenEnv : undefined;
        const literal = own(entry, "bearerToken") ? entry.bearerToken : undefined;
        const value = typeof envName === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) ? `Bearer \${${envName}}`
          : typeof literal === "string" && literal.length > 0 ? `Bearer ${literal}`
            : undefined;
        if (!value) issue("unsupported-auth-mode", "auth", name);
        else if (own(entry, "headers") && record(entry.headers) && own(entry.headers, "Authorization")) issue("conflicting-authorization-header", "headers", name);
        else entry.headers = { ...(record(entry.headers) ? entry.headers : {}), Authorization: value };
        delete entry.auth; delete entry.bearerToken; delete entry.bearerTokenEnv;
      } else {
        issue("unsupported-auth-mode", "auth", name);
      }
    }
    if (own(entry, "protocolVersion")) {
      if (entry.protocolVersion !== "auto") issue("pinned-protocol-version", "protocolVersion", name);
      delete entry.protocolVersion;
    }
    if (own(entry, "httpTransport")) {
      if (entry.httpTransport !== "streamable-http") issue("unsupported-transport", "httpTransport", name);
      delete entry.httpTransport;
    }
    if (entry.type === "sse") issue("unsupported-transport", "type", name);
    // Legacy OAuth client settings: `scopes` is the adapter's array, native takes one space-separated
    // `scope`. `authorizationParams` has no native equivalent (the SDK owns the flow), so it refuses
    // instead of silently dropping behavior the caller asked for.
    if (own(entry, "oauth") && record(entry.oauth)) {
      const oauth = entry.oauth;
      if (own(oauth, "scopes")) {
        const scopes = oauth.scopes;
        if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
          issue("invalid-oauth-scopes", "oauth.scopes", name);
        } else if (own(oauth, "scope")) issue("conflicting-oauth-scope", "oauth.scope", name);
        else oauth.scope = scopes.join(" ");
        delete oauth.scopes;
      }
      if (own(oauth, "authorizationParams") && record(oauth.authorizationParams) && Object.keys(oauth.authorizationParams).length > 0) {
        issue("unsupported-oauth-authorization-params", "oauth.authorizationParams", name);
      }
    }
    if (entry.exposure === "codemode-deferred") entry.exposure = "codemode";
    if (record(entry.toolExposure)) {
      for (const [tool, exposure] of Object.entries(entry.toolExposure)) {
        if (exposure === "codemode-deferred") entry.toolExposure[tool] = "codemode";
      }
    }
    entries.push([name, entry]);
  }
  if (issues.length) return { ok: false, issues, config: null };
  const config = { mcpServers: Object.fromEntries(entries) };
  if (own(userConfig, "autoEnableCodemode")) config.autoEnableCodemode = userConfig.autoEnableCodemode;
  else if (own(bundledConfig, "autoEnableCodemode")) config.autoEnableCodemode = bundledConfig.autoEnableCodemode;
  return { ok: true, issues: [], config };
}
