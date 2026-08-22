import { hostTranslationPath, resolveHostControlUrl } from "@/lib/host-control";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { texts?: unknown } | null;
  const texts = body?.texts;
  if (
    !Array.isArray(texts) ||
    texts.length < 1 ||
    texts.length > 16 ||
    texts.some((text) => typeof text !== "string" || !text.trim()) ||
    texts.reduce((sum, text) => sum + (typeof text === "string" ? text.length : 0), 0) > 16_000
  ) {
    return NextResponse.json({ error: "texts must contain 1-16 short strings" }, { status: 400 });
  }

  try {
    const res = await fetch(`${resolveHostControlUrl()}${hostTranslationPath("translate")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      cache: "no-store",
      // The quality gate may perform one 30-second retry after the initial
      // local inference, so keep the proxy alive for both bounded attempts.
      signal: AbortSignal.timeout(65_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof data.error === "string" ? data.error : "ローカル翻訳に失敗しました" },
        { status: res.status === 503 ? 503 : 502 },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ローカル翻訳サービスに接続できません" },
      { status: 503 },
    );
  }
}
