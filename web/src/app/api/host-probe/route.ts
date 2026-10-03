import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isPrivateHost } from "@/lib/localhost-redirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-process identity for the localhost-redirect probe. The browser compares the
 * id served by its own origin with the id served by http://127.0.0.1:<port>; they
 * match only when both reach the same WebUI process (= the browser is on the host).
 * Another PC running its own LeafCodePi on the same port yields a different id.
 * The id is random and carries no other information.
 */
const globalKey = Symbol.for("leafcode-pi.host-probe-id");
type GlobalWithProbe = typeof globalThis & { [globalKey]?: string };
const g = globalThis as GlobalWithProbe;
const instanceId = (g[globalKey] ??= randomUUID());

/**
 * Only pages served from a private/LAN/VPN address (the only ones the redirect runs on, see
 * `maybeRedirectToLocalhost`) may read the probe. A public web page cannot learn whether
 * LeafCodePi runs on this machine. Same-origin requests carry no Origin and need no CORS.
 */
function corsHeaders(request?: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    // Chrome Private Network Access preflight (private origin -> loopback).
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  const origin = request?.headers.get("origin");
  if (origin && isPrivateOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function isPrivateOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return isPrivateHost(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

export function GET(request?: Request) {
  return NextResponse.json({ id: instanceId }, { headers: corsHeaders(request) });
}

export function OPTIONS(request?: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
