import { NextResponse } from "next/server";
import { createPeerGrantStore } from "@backend-core/peer-auth-grants.mjs";
import { createPeerAdmin, type PeerAdminResult } from "@/lib/peer-auth/admin";
import { webUiAuthRequired } from "@/lib/webui-auth-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Protected by the WebUI token layer (not listed in isPublicWebUiPath).
const admin = () => createPeerAdmin({ store: createPeerGrantStore(), authRequired: webUiAuthRequired });
const respond = (result: PeerAdminResult) =>
  NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
const readJson = (request: Request) => request.json().catch(() => undefined);

export async function GET() {
  return respond(admin().get());
}

export async function POST(request: Request) {
  return respond(admin().create(await readJson(request)));
}

export async function PATCH(request: Request) {
  return respond(admin().setEnabled(await readJson(request)));
}

export async function DELETE(request: Request) {
  return respond(admin().revoke(new URL(request.url).searchParams.get("id")));
}
