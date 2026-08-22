import { hostTranslationPath, resolveHostControlUrl } from "@/lib/host-control";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    text?: unknown;
    translation?: unknown;
  } | null;
  if (
    typeof body?.text !== "string" ||
    typeof body?.translation !== "string" ||
    !body.text.trim() ||
    !body.translation.trim() ||
    body.text.length > 16_000 ||
    body.translation.length > 16_000
  ) {
    return NextResponse.json(
      { error: "原文と修正訳を入力してください" },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(
      `${resolveHostControlUrl()}${hostTranslationPath("override")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body.text, translation: body.translation }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return NextResponse.json(
        { error: typeof result.error === "string" ? result.error : "修正訳を保存できませんでした" },
        { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "翻訳サービスに接続できません" },
      { status: 503 },
    );
  }
}
