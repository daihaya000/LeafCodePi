import { publicMcpAuthSnapshot } from "./mcp-auth-snapshot.mjs";

const fields = ["id", "name", "enabled", "bundled", "userConfigured", "source", "authType", "credentialConfigured", "credentialSource", "credentialStatus"];
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Static metadata only: no commands, arguments, env, credentials, paths or provider messages. */
export function publicMcpServerList(value) {
  if (!plain(value) || !Object.hasOwn(value, "servers") || !Array.isArray(value.servers)) return null;
  const servers = [];
  const names = new Set();
  for (const row of value.servers) {
    if (!plain(row) || fields.some((key) => !Object.hasOwn(row, key))
      || typeof row.name !== "string" || !row.name.trim() || /[\x00-\x1f\x7f]/.test(row.name)
      || row.id !== row.name || names.has(row.name)
      || typeof row.enabled !== "boolean" || typeof row.bundled !== "boolean" || typeof row.userConfigured !== "boolean"
      || !["stdio", "http"].includes(row.source)) return null;
    const auth = publicMcpAuthSnapshot({ ...row, url: row.source === "http" && Object.hasOwn(row, "url") ? row.url : undefined });
    if (!auth) return null;
    const { configPath: ignored, ...metadata } = auth;
    servers.push({ id: row.id, ...metadata, enabled: row.enabled, bundled: row.bundled,
      userConfigured: row.userConfigured, source: row.source });
    names.add(row.name);
  }
  // Retain the response shape without disclosing Backend-local filesystem locations.
  return { servers, configPath: "", bundledConfigPath: null };
}
