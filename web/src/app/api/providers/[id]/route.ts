import { NextRequest, NextResponse } from "next/server";
import { jsonError, setProviderAccountRoutingMode } from "@/lib/pi/harness";
import type { AccountRoutingMode } from "@/lib/provider-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let providerId: string;
  try {
    providerId = decodeURIComponent((await params).id);
  } catch {
    return NextResponse.json({ error: "プロバイダーIDが不正です" }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as { accountRoutingMode?: unknown } | null;
  const mode = body?.accountRoutingMode;
  if (mode !== "integrated" && mode !== "separate") {
    return NextResponse.json({ error: "accountRoutingMode が不正です" }, { status: 400 });
  }
  try {
    await setProviderAccountRoutingMode(providerId, mode as AccountRoutingMode);
    return NextResponse.json({ accountRoutingMode: mode });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
