import { NextRequest, NextResponse } from "next/server";
import { jsonError, setTaskAgent } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { agent?: unknown } | null;
    if (typeof body?.agent !== "string") {
      return NextResponse.json({ error: "agent が必要です" }, { status: 400 });
    }
    return NextResponse.json({ task: await setTaskAgent(id, body.agent) });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
