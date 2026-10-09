type OriginRequest = { headers: Headers; nextUrl: URL };

function authorityOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(`http://${value.split(",")[0].trim()}`);
    if (url.username || url.password) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Browser CSRF guard for state-changing routes.
 * `nextUrl.origin` reflects the server bind address (e.g. 0.0.0.0 or a Tailscale IP), not the host the
 * browser used, so compare the Origin authority with the Host / X-Forwarded-Host headers as well.
 * The scheme is ignored because TLS-terminating proxies make the server see http while the browser sends https.
 */
export function isCrossOriginRequest(req: OriginRequest): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (origin === req.nextUrl.origin) return false;
  let originAuthority: string;
  try {
    originAuthority = new URL(origin).host.toLowerCase();
  } catch {
    return true; // includes the opaque "null" origin
  }
  const allowed = [
    authorityOf(req.headers.get("host")),
    authorityOf(req.headers.get("x-forwarded-host")),
    req.nextUrl.host.toLowerCase(),
  ];
  return !allowed.includes(originAuthority);
}
