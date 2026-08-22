import { hostTranslationPath, resolveHostControlUrl } from "@/lib/host-control";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kick off translation/install.py on the host. Returns 202 immediately;
 *  progress is tracked via /api/translation/status (installState). */
export async function POST() {
  try {
    const res = await fetch(`${resolveHostControlUrl()}${hostTranslationPath("install")}`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            typeof data.error === "string" ? data.error : "ローカル翻訳の導入を開始できませんでした",
        },
        { status: 502 },
      );
    }
    return NextResponse.json(data, { status: 202 });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? `ホスト制御に接続できません: ${err.message}`
            : "ホスト制御に接続できません",
        hint: "start.bat（トレイホスト）経由で起動しているか確認してください",
      },
      { status: 502 },
    );
  }
}
