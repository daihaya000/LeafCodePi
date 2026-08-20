import { NextResponse } from "next/server";
import { answerProviderLogin, cancelProviderLogin, jsonError } from "@/lib/pi/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { promptId?: string; value?: string };
    if (!body.promptId || typeof body.value !== "string") {
      return NextResponse.json({ error: "promptId と value が必要です" }, { status: 400 });
    }
    answerProviderLogin(body.promptId, body.value);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  try {
    cancelProviderLogin();
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
