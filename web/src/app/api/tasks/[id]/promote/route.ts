import { NextRequest, NextResponse } from "next/server";
import { jsonError, promoteTask } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      destinationPath?: unknown;
    } | null;
    if (typeof body?.destinationPath !== "string" || !body.destinationPath.trim()) {
      return NextResponse.json(
        { error: "destinationPath が必要です" },
        { status: 400 },
      );
    }
    return NextResponse.json(await promoteTask(id, body.destinationPath));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
