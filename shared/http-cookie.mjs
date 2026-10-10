/** Web-edge cookie serialization; no owner, persistence or framework dependency. */
export function setResponseCookie(response, name, value, options = {}, now = Date.now()) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError("Invalid cookie name");
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`];
  const expires = options.maxAge ? new Date(now + options.maxAge * 1000) : options.expires;
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure) parts.push("Secure");
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite === true ? "strict" : options.sameSite}`);
  const retained = response.headers.getSetCookie().filter(cookie => !cookie.startsWith(`${name}=`));
  response.headers.delete("set-cookie");
  for (const cookie of retained) response.headers.append("set-cookie", cookie);
  response.headers.append("set-cookie", parts.join("; "));
  return response;
}
export function requestCookie(headers, name) {
  const values = new Map();
  for (const part of (headers.get("cookie") ?? "").split(/; */)) {
    const at = part.indexOf("=");
    if (at < 0) { if (part) values.set(part, "true"); continue; }
    try { values.set(part.slice(0, at), decodeURIComponent(part.slice(at + 1))); } catch { /* Invalid cookie is not authentication. */ }
  }
  return values.get(name);
}
