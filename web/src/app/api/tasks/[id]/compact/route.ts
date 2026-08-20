import { NextRequest, NextResponse } from "next/server";
import { compactTask, jsonError } from "@/lib/pi/harness";

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
      | { customInstructions?: string }
      | null;
    const task = await compactTask(id, body?.customInstructions);
    return NextResponse.json({ task });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
