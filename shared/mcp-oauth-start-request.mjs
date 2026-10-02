/** OAuth start accepts no credentials, callback inputs, configuration or transport options. */
export function parseMcpOAuthStartRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
    || Object.keys(body).some((key) => !["type", "action"].includes(key))
    || !Object.hasOwn(body, "type") || body.type !== "oauth"
    || ("action" in body && (!Object.hasOwn(body, "action") || body.action !== "start"))) return { ok: false };
  return { ok: true, value: { type: "oauth", action: "start" } };
}

/** Preserve functional state/PKCE parameters, but never publish credential-bearing or executable URLs. */
export function publicMcpOAuthStartResult(value) {
  if (!value || typeof value !== "object" || value.ok !== true || typeof value.name !== "string"
    || !value.name || value.name.trim() !== value.name || /[\x00-\x1f\x7f/\\]/.test(value.name) || value.name.includes("..")) return null;
  if (value.status === "authenticated") {
    if (value.authorizationUrl !== undefined && value.authorizationUrl !== "") return null;
    return { ok: true, name: value.name, status: "authenticated" };
  }
  if (value.status !== "pending" || typeof value.authorizationUrl !== "string"
    || !value.authorizationUrl || value.authorizationUrl.length > 16384 || /[\x00-\x1f\x7f]/.test(value.authorizationUrl)) return null;
  try {
    const url = new URL(value.authorizationUrl);
    const loopback = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) return null;
    for (const key of url.searchParams.keys()) {
      if (/secret|password|token|authorization|code_verifier|api[-_]?key/i.test(key) || key.toLowerCase() === "code") return null;
    }
    return { ok: true, name: value.name, status: "pending", authorizationUrl: url.href };
  } catch { return null; }
}
