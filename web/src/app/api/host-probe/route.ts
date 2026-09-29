import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  // Chrome Private Network Access preflight (public origin -> loopback).
  "Access-Control-Allow-Private-Network": "true",
  "Cache-Control": "no-store",
};

export function GET() {
  return NextResponse.json({ id: instanceId }, { headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
