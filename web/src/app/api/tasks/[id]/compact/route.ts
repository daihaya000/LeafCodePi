import { NextRequest, NextResponse } from "next/server";
import { compactTask, jsonError } from "@/lib/pi/harness";
import { isPromptTextWithinSize } from "@/lib/prompt-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Compaction LLM calls can take several minutes. */
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as
      | { customInstructions?: unknown }
      | null;
    if (body?.customInstructions !== undefined && typeof body.customInstructions !== "string") {
      return NextResponse.json({ error: "customInstructions must be a string" }, { status: 400 });
    }
    // This text is embedded directly into the compaction summarization prompt (see
    // AgentSession.compact -> generateSummary's "Additional focus"), so it needs the same
    // bound as every other endpoint that feeds user text straight into a model call.
    if (
      typeof body?.customInstructions === "string" &&
      !isPromptTextWithinSize(body.customInstructions)
    ) {
      return NextResponse.json({ error: "本文プロンプトが長すぎます" }, { status: 413 });
    }
    const customInstructions = typeof body?.customInstructions === "string"
      ? body.customInstructions
      : undefined;
    const task = await compactTask(id, customInstructions);
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
