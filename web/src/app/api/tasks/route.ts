import { NextRequest, NextResponse } from "next/server";
import {
  createTask,
  destroyArchivedTasksByProject,
  getTaskSummaries,
  jsonError,
  listPendingAttention,
} from "@/lib/pi/harness";
import type { ThinkingLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  // GlobalAttentionProvider のポーリング用（軽量リスト）。
  if (req.nextUrl.searchParams.get("attention") === "1") {
    return NextResponse.json({ attention: listPendingAttention() });
  }
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
      permissionMode?: "allow" | "ask" | "deny";
      skillPermission?: "allow" | "deny";
      goalLoop?: {
        enabled?: unknown;
        acceptance?: unknown;
        maxTurns?: unknown;
        forceFullRun?: unknown;
      };
    } | null;
    if (!body?.projectId || !body.prompt?.trim()) {
      return NextResponse.json({ error: "projectId と prompt が必要です" }, { status: 400 });
    }
    if (body.goalLoop?.enabled === true && body.images?.length) {
      return NextResponse.json({ error: "Goal loop の開始では画像添付は使えません" }, { status: 400 });
    }
    let goalLoop:
      | { acceptance: string[]; maxTurns: number; forceFullRun: boolean }
      | undefined;
    if (body.goalLoop?.enabled === true) {
      const raw = body.goalLoop.acceptance;
      const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : [];
      if (
        values.length > 10 ||
        values.some((item) => typeof item !== "string" || item.trim().length > 2_000)
      ) {
        return NextResponse.json({ error: "acceptance が不正です" }, { status: 400 });
      }
      const number = Number(body.goalLoop.maxTurns ?? 10);
      goalLoop = {
        acceptance: values
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
        maxTurns: Number.isFinite(number) ? Math.min(100, Math.max(1, Math.trunc(number))) : 10,
        forceFullRun: body.goalLoop.forceFullRun === true,
      };
    }
    const task = await createTask({
      projectId: body.projectId,
      prompt: body.prompt,
      model: body.model,
      thinkingLevel: body.thinkingLevel,
      images: body.images,
      agent: body.agent,
      subagentPermission: body.subagentPermission,
      permissionMode: body.permissionMode,
      skillPermission: body.skillPermission,
      goalLoop,
    });
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
