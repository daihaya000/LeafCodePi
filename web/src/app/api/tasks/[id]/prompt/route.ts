import { NextRequest, NextResponse } from "next/server";
import { jsonError, promptTask } from "@/lib/pi/harness";
import type { ThinkingLevel } from "@/lib/types";

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
      model?: string;
      thinkingLevel?: ThinkingLevel;
      agent?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: "allow" | "ask" | "deny";
      skillPermission?: "allow" | "deny";
      streamingBehavior?: "steer" | "followUp";
    } | null;
    if (!body?.prompt?.trim() && !body?.images?.length) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    if (
      body?.streamingBehavior !== undefined &&
      !["steer", "followUp"].includes(body.streamingBehavior)
    ) {
      return NextResponse.json({ error: "無効な送信方式です" }, { status: 400 });
    }
    const task = await promptTask(id, body.prompt ?? "", body.images, {
      model: body.model,
      thinkingLevel: body.thinkingLevel,
      agent: body.agent,
      subagentPermission: body.subagentPermission,
      permissionMode: body.permissionMode,
      skillPermission: body.skillPermission,
      streamingBehavior: body.streamingBehavior,
    });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
