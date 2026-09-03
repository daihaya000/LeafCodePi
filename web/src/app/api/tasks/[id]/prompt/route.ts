import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { readSessionConversation } from "@/lib/direct-session";
import { parseDirectModelKey } from "@/lib/direct-generation";
import { resolveAutoAgent } from "@/lib/auto-agent";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
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
      auto?: unknown;
      agent?: string;
      subagentPermission?: "allow" | "deny";
      permissionMode?: "allow" | "ask" | "deny";
      skillPermission?: "allow" | "deny";
      streamingBehavior?: "steer" | "followUp";
    } | null;
    if (!body?.prompt?.trim() && !body?.images?.length) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    if (body?.agent !== undefined && typeof body.agent !== "string") {
      return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    }
    if (body?.auto !== undefined && typeof body.auto !== "boolean") {
      return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    }
    if (
      body?.streamingBehavior !== undefined &&
      !["steer", "followUp"].includes(body.streamingBehavior)
    ) {
      return NextResponse.json({ error: "無効な送信方式です" }, { status: 400 });
    }
    let agent = body?.agent;
    if (agent?.trim() === AUTO_AGENT_VALUE) {
      const currentTask = getTask(id);
      if (!currentTask) {
        return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 });
      }
      // An active turn cannot replace its session persona. The UI normally
      // disables this path, but keep a stale browser request safe as well.
      if (currentTask.status === "working") {
        agent = currentTask.agent?.trim() || undefined;
      } else {
        const taskModel =
          currentTask.providerID && currentTask.modelID
            ? {
                providerID: currentTask.providerID,
                modelID: currentTask.modelID,
                ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
              }
            : undefined;
        const requestedModel = parseDirectModelKey(body.model) ?? taskModel;
        agent = await resolveAutoAgent({
          conversation: readSessionConversation(currentTask.sessionFile),
          prompt: body.prompt ?? "",
          hasImages: Boolean(body.images?.length),
          ...(requestedModel ? { requestedModel } : {}),
          ...(currentTask.accountId ? { accountId: currentTask.accountId } : {}),
        });
      }
    }
    const task = await promptTask(id, body.prompt ?? "", body.images, {
      model: body.model,
      thinkingLevel: body.thinkingLevel,
      agent,
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
