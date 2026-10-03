import { NextResponse } from "next/server";
import { importPeerAccount } from "@/lib/peer-auth/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Protected by the WebUI token layer (not listed in isPublicWebUiPath).
export async function POST(request: Request) {
  const result = await importPeerAccount(await request.json().catch(() => undefined));
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
