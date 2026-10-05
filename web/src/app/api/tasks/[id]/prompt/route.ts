import { NextRequest, NextResponse } from "next/server";
import {
  isPromptFileList, isPromptFileText, isPromptFileWithinSize, isPromptImageList,
  isPromptImageWithinSize, isPromptTextWithinSize, MAX_PROMPT_ATTACHMENTS,
} from "@/lib/prompt-images";
import { isAutoOptimizeMode } from "@/lib/auto-model";
import { jsonError } from "@/lib/pi/harness";
import { handleTaskPrompt, type TaskPromptBody } from "@/lib/pi/task-prompt";
import { localRuntimeBlocked } from "@/lib/pi/runtime-ownership";
import { forwardTaskPrompt } from "@/lib/backend-forward";
import { wakeBackendTaskListeners } from "@/lib/backend-task-dirty-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as TaskPromptBody | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    if (body.prompt !== undefined && typeof body.prompt !== "string") {
      return NextResponse.json({ error: "invalid prompt" }, { status: 400 });
    }
    if (!body.prompt?.trim() && !body.images?.length && !body.files?.length) {
      return NextResponse.json({ error: "prompt が必要です" }, { status: 400 });
    }
    if (typeof body.prompt === "string" && !isPromptTextWithinSize(body.prompt)) {
      return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
    }
    if (body.images !== undefined && (!isPromptImageList(body.images) || body.images.some((image) => !isPromptImageWithinSize(image)))) {
      return NextResponse.json({ error: "invalid images" }, { status: 400 });
    }
    if (body.files !== undefined && (!isPromptFileList(body.files) || body.files.some((file) => !isPromptFileWithinSize(file) || !isPromptFileText(file)))) {
      return NextResponse.json({ error: "invalid files: UTF-8 text only" }, { status: 400 });
    }
    if ((body.images?.length ?? 0) + (body.files?.length ?? 0) > MAX_PROMPT_ATTACHMENTS) {
      return NextResponse.json({ error: `添付は${MAX_PROMPT_ATTACHMENTS}件までです` }, { status: 400 });
    }
    if (body.agent !== undefined && typeof body.agent !== "string") return NextResponse.json({ error: "invalid agent" }, { status: 400 });
    if (body.model !== undefined && typeof body.model !== "string") return NextResponse.json({ error: "invalid model" }, { status: 400 });
    if (body.auto !== undefined && typeof body.auto !== "boolean") return NextResponse.json({ error: "invalid auto" }, { status: 400 });
    if (body.autoRetry !== undefined && typeof body.autoRetry !== "boolean") return NextResponse.json({ error: "invalid autoRetry" }, { status: 400 });
    if (body.resume !== undefined && typeof body.resume !== "boolean") return NextResponse.json({ error: "invalid resume" }, { status: 400 });
    if (body.autoOptimize !== undefined && !isAutoOptimizeMode(body.autoOptimize)) return NextResponse.json({ error: "invalid autoOptimize" }, { status: 400 });
    if ((body.autoRetry === true || body.autoOptimize !== undefined || body.autoRouteOverrides !== undefined) && body.auto !== true) {
      return NextResponse.json({ error: "Auto設定にはautoが必要です" }, { status: 400 });
    }
    if (body.streamingBehavior !== undefined && !["steer", "followUp"].includes(body.streamingBehavior)) {
      return NextResponse.json({ error: "無効な送信方式です" }, { status: 400 });
    }
    if (body.interruptIfSafe !== undefined && (typeof body.interruptIfSafe !== "boolean" || body.streamingBehavior !== "steer")) {
      return NextResponse.json({ error: "無効な割り込み方式です" }, { status: 400 });
    }
    if (localRuntimeBlocked()) {
      const forwarded = await forwardTaskPrompt(id, body);
      if (forwarded.ok) {
        // The owner has the prompt: refresh this process's open streams now, not after its wake.
        wakeBackendTaskListeners(id, "prompt");
        if (forwarded.result) return NextResponse.json(forwarded.result.body, { status: forwarded.result.status });
        return NextResponse.json({ task: forwarded.task });
      }
      if (forwarded.reason === "not-configured") {
        return NextResponse.json({ error: "Backendが実行を所有しています", code: "RUNTIME_NOT_OWNED" }, { status: 409 });
      }
      if (forwarded.reason === "bad-response" && forwarded.status && forwarded.status >= 400 && forwarded.status < 500) {
        return NextResponse.json({ error: "Backendで送信を実行できません", code: "BACKEND_REQUEST_REJECTED" }, { status: forwarded.status });
      }
      return NextResponse.json({ error: "Backendへ転送できません", code: "BACKEND_FORWARD_FAILED", reason: forwarded.reason }, { status: 502 });
    }
    const result = await handleTaskPrompt(id, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
