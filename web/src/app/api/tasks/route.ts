import { NextRequest, NextResponse } from "next/server";
import {
  createTask,
  destroyArchivedTasksByProject,
  getTaskSummaries,
  jsonError,
} from "@/lib/pi/harness";
import type { ThinkingLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  return NextResponse.json({ tasks: getTaskSummaries(includeArchived) });
}

export async function DELETE(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get("projectId");
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    return NextResponse.json(destroyArchivedTasksByProject(projectId));
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      projectId?: string;
      prompt?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      images?: { mimeType: string; data: string }[];
      agent?: string;
      subagentPermission?: "allow" | "deny";
    } | null;
    if (!body?.projectId || !body.prompt?.trim()) {
      return NextResponse.json({ error: "projectId と prompt が必要です" }, { status: 400 });
    }
    const task = await createTask({
      projectId: body.projectId,
      prompt: body.prompt,
      model: body.model,
      thinkingLevel: body.thinkingLevel,
      images: body.images,
      agent: body.agent,
      subagentPermission: body.subagentPermission,
    });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
