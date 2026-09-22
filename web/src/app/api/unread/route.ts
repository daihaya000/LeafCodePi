import { NextRequest, NextResponse } from "next/server";
import { getUnreadReadMarkers, markUnreadRead } from "@/lib/unread-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ markers: getUnreadReadMarkers() });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { kind?: unknown; id?: unknown; readAt?: unknown }
    | null;
  const readAt = markUnreadRead(body?.kind, body?.id, body?.readAt);
  if (readAt === null) return NextResponse.json({ error: "invalid unread marker" }, { status: 400 });
  return NextResponse.json({ readAt });
}
