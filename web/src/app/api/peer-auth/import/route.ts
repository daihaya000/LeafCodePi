import { NextResponse } from "next/server";
import { importPeerAccount, listPeerAccounts } from "@/lib/peer-auth/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Protected by the WebUI token layer (not listed in isPublicWebUiPath).

/** Imported peer accounts and whether the sharing LCP answers right now. */
export async function GET() {
  return NextResponse.json({ peers: await listPeerAccounts() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const result = await importPeerAccount(await request.json().catch(() => undefined));
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
