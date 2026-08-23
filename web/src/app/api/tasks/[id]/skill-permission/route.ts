import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskSkillPermission } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { permission?: string } | null;
    const permission = body?.permission;
    if (permission !== "allow" && permission !== "deny") {
      return NextResponse.json({ error: "permission must be allow or deny" }, { status: 400 });
    }
    return NextResponse.json({ task: await setTaskSkillPermission(id, permission) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
