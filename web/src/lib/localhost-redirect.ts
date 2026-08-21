/**
 * Host-PC auto-redirect: when the browser is opened on the host machine via a
 * LAN/VPN IP (e.g. the Tailscale address), redirect it to the loopback URL so
 * host-only features (native folder picker, restart) keep working.
 *
 * A remote phone reaches the WebUI via the same IP, but its own 127.0.0.1 has
 * no WebUI. The reachability probe below only succeeds on the host itself, so
 * remote clients are never redirected. Only protocol/port-preserving hostname
 * swap happens; no session state is involved.
 */

import { isLoopbackHost } from "@/lib/loopback";

export { isLoopbackHost };

const PROBE_TIMEOUT_MS = 800;

/** True for a bare private IPv4 / unique-local address (RFC 1918 / RFC 4193). */
export function isPrivateHost(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (isLoopbackHost(v)) return true;
  if (/^10\./.test(v)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  // Tailscale and several other VPNs use the shared CGNAT range.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)) return true;
  if (/^fc/.test(v) || /^fd/.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  return false;
}

/**
 * True when this browser is on the host machine and can reach the WebUI on its
 * own loopback. Resolves false on any timeout / network error (fail-closed).
 */
async function canReachLoopbackWebui(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${window.location.port}/api/health`, {
      mode: "no-cors",
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // With `no-cors` any HTTP response (even an error status) yields an opaque
    // response; only a network-level failure throws. Either way, no throw
    // means the host's loopback WebUI answered us.
    return true;
  } catch {
    return false;
  }
}

function extractHostname(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end !== -1) return s.slice(1, end);
  }
  const colon = s.indexOf(":");
  return colon === -1 ? s : s.slice(0, colon);
}

/**
 * Redirect the current page to its loopback twin when (a) we are not already
 * on loopback, (b) the Host is a private/LAN address, and (c) the WebUI on
 * 127.0.0.1 is reachable (so this browser really is on the host PC).
 *
 * Runs only in the browser. Returns the target URL when a redirect was issued,
 * otherwise null.
 */
export async function maybeRedirectToLocalhost(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const hostname = extractHostname(window.location.hostname);
  if (isLoopbackHost(hostname)) return null;
  // Only redirect private-network hosts. A public hostname (e.g. a reverse
  // proxy domain) should be left alone — it may be the intended access path.
  if (!isPrivateHost(hostname)) return null;
  if (!(await canReachLoopbackWebui())) return null;

  const target = new URL(window.location.href);
  target.hostname = "127.0.0.1";
  const to = target.toString();
  window.location.replace(to);
  return to;
}
