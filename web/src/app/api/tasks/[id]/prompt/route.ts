import { NextRequest, NextResponse } from "next/server";
import { jsonError, promptTask } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      prompt?: string;
      images?: { mimeType: string; data: string }[];
      agent?: string;
      subagentPermission?: "allow" | "deny";
    } | null;
    if (!body?.prompt?.trim() && !body?.images?.length) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    const task = await promptTask(id, body.prompt ?? "", body.images, {
      agent: body.agent,
      subagentPermission: body.subagentPermission,
    });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
