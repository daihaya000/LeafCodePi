const authTypes = new Set(["none", "bearer", "oauth", "headers", "auto"]);
const sources = new Set(["none", "config", "environment", "secure-store", "oauth", "headers"]);
const statuses = new Set(["present", "missing", "expired", "unknown", "unavailable", "url-mismatch"]);

/** Whitelist public auth metadata. Never forward paths, arbitrary messages or credentials. */
export function publicMcpAuthSnapshot(value) {
  if (!value || typeof value !== "object" || typeof value.name !== "string"
    || !authTypes.has(value.authType) || !sources.has(value.credentialSource)
    || !statuses.has(value.credentialStatus) || typeof value.credentialConfigured !== "boolean") return null;
  let url;
  if (typeof value.url === "string") {
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
        url = parsed.toString();
      }
    } catch { /* Invalid/templates are not public endpoint values. */ }
  }
  return { name: value.name, configPath: "", ...(url ? { url } : {}), authType: value.authType,
    credentialConfigured: value.credentialConfigured, credentialSource: value.credentialSource,
    credentialStatus: value.credentialStatus };
}
