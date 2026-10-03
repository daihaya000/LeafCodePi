/**
 * Names a spawned MCP child inherits implicitly: what an executable, a shell or a TLS/proxy stack
 * needs to start at all. Everything else in the Backend environment (tokens for other services,
 * session material) has no business reaching a child it did not ask for: a stdio server declares what
 * it needs in its own `env`, where `${NAME}` still expands from the full snapshot.
 *
 * Matching is case-insensitive on Windows and exact on POSIX, because that is how the OS treats env
 * names there.
 */
const INHERITED_ENV_NAMES = new Set([
  "path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir",
  "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programdata",
  "programfiles", "programfiles(x86)", "commonprogramfiles", "commonprogramfiles(x86)",
  "number_of_processors", "processor_architecture", "processor_identifier", "os",
  "home", "lang", "language", "lc_all", "lc_ctype", "tz", "shell", "term",
  "ssl_cert_file", "ssl_cert_dir", "node_extra_ca_certs", "node_path", "node_options",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);

/** Config prefixes that are tooling settings rather than another service's credential. */
const INHERITED_ENV_PREFIXES = ["npm_config_", "npm_package_", "pnpm_", "yarn_", "NPM_CONFIG_", "PNPM_", "YARN_"];

const envKey = (key) => (process.platform === "win32" ? key.toLowerCase() : key);

/** True when a child may see this variable without the configuration asking for it. */
export function isInheritedEnvName(name) {
  return INHERITED_ENV_NAMES.has(name) || INHERITED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The subset of `entries` a child inherits. `entries` is a Map keyed by `envKey(key)` with
 * `[originalKey, value]` values, the shape `mcp-native-stdio-transport.mjs` builds.
 */
export function inheritedEnvEntries(entries) {
  const result = new Map();
  for (const [normalized, pair] of entries) {
    if (isInheritedEnvName(envKey(normalized))) result.set(normalized, pair);
  }
  return result;
}

/** The same policy for a plain `process.env`-shaped object. */
export function inheritedEnv(source = process.env) {
  const result = {};
  for (const key of Object.keys(source)) {
    if (isInheritedEnvName(envKey(key))) result[key] = source[key];
  }
  return result;
}