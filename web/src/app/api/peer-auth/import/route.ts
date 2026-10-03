import { NextResponse } from "next/server";
import { isWebUiRequestAuthorized } from "@/lib/webui-auth";
import { importPeerAccount, listPeerAccounts } from "@/lib/peer-auth/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This route triggers outbound requests to peer URLs, so require WebUI auth even when the global
// token layer is disabled. Otherwise an unauthenticated caller could use it as an internal probe.
function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/** Imported peer accounts and whether the sharing LCP answers right now. */
export async function GET(request: Request) {
  if (!isWebUiRequestAuthorized(request)) return unauthorized();
  return NextResponse.json({ peers: await listPeerAccounts() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isWebUiRequestAuthorized(request)) return unauthorized();
  const result = await importPeerAccount(await request.json().catch(() => undefined));
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
