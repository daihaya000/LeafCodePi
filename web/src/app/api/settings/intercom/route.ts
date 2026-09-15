import { NextRequest, NextResponse } from "next/server";
import { readIntercomTriggerPolicy, writeIntercomTriggerPolicy } from "@/lib/intercom-config";
import { isIntercomTriggerPolicy } from "@/lib/intercom-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Intercom設定の処理に失敗しました";
}

export async function GET() {
  try {
    return NextResponse.json({ inboundTrigger: readIntercomTriggerPolicy() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { inboundTrigger?: unknown } | null;
  const inboundTrigger = body?.inboundTrigger;
  if (!isIntercomTriggerPolicy(inboundTrigger)) {
    return NextResponse.json(
      { error: 'inboundTrigger は "replies"、"always"、または "never" です' },
      { status: 400 },
    );
  }

  try {
    const saved = writeIntercomTriggerPolicy(inboundTrigger);
    return NextResponse.json({ inboundTrigger: saved });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
