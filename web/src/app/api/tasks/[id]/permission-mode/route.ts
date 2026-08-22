import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskPermissionMode } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { mode?: string } | null;
    const mode = body?.mode;
    if (mode !== "allow" && mode !== "ask" && mode !== "deny") {
      return NextResponse.json({ error: "mode must be allow, ask, or deny" }, { status: 400 });
    }
    return NextResponse.json({ task: await setTaskPermissionMode(id, mode) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
