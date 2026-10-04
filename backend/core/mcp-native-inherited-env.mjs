/**
 * Names a spawned MCP child inherits implicitly: what an executable, a shell or a TLS/proxy stack
 * needs to start at all. Everything else in the Backend environment (tokens for other services,
 * session material) has no business reaching a child it did not ask for: a stdio server declares what
 * it needs in its own `env`, where `${NAME}` still expands from the full snapshot.
 *
 * Names are compared upper-cased on every platform, so one list serves them all. Windows ignores case
 * in environment names; on POSIX the well-known ones are upper-case (`PATH`, `HOME`, `LANG`) and only
 * the proxy variables are used in both spellings. Accepting another spelling of one of these names
 * costs nothing, while comparing case-sensitively against a lower-case list dropped `PATH` and `HOME`
 * on every POSIX host.
 */
const INHERITED_ENV_NAMES = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS",
  "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_PATH", "NODE_OPTIONS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);

/**
 * Tooling settings come in families (`npm_config_registry`, `PNPM_HOME`, `YARN_CACHE_FOLDER`). A family
 * also holds that tool's credentials (`npm_config__authToken`, `npm_config_//host/:_password`,
 * `YARN_NPM_AUTH_TOKEN`), so a family member is inherited only when its name does not look like one.
 */
const INHERITED_ENV_PREFIXES = ["NPM_CONFIG_", "NPM_PACKAGE_", "PNPM_", "YARN_"];
const CREDENTIAL_LIKE = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|AUTH|KEY|CREDENTIAL/;

/** True when a child may see this variable without the configuration asking for it. */
export function isInheritedEnvName(name) {
  const upper = name.toUpperCase();
  if (INHERITED_ENV_NAMES.has(upper)) return true;
  return INHERITED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)) && !CREDENTIAL_LIKE.test(upper);
}

/**
 * The subset of `entries` a child inherits. `entries` is a Map keyed by the platform-normalized name
 * with `[originalKey, value]` values, the shape `mcp-native-stdio-transport.mjs` builds.
 */
export function inheritedEnvEntries(entries) {
  const result = new Map();
  for (const [normalized, pair] of entries) {
    if (isInheritedEnvName(normalized)) result.set(normalized, pair);
  }
  return result;
}

/** The same policy for a plain `process.env`-shaped object. */
export function inheritedEnv(source = process.env) {
  const result = {};
  for (const key of Object.keys(source)) {
    if (isInheritedEnvName(key)) result[key] = source[key];
  }
  return result;
}
