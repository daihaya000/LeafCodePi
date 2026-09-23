import { NextRequest, NextResponse } from "next/server";
import { normalizeJevModelSettings } from "@/lib/jev-model-settings";
import { getJevModelSettingsDto, saveJevModelSettings } from "@/lib/pi/jev-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getJevModelSettingsDto());
  } catch {
    return NextResponse.json({ error: "Jevモデル設定を取得できません" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const origin = req.headers.get("origin");
  if ((origin && origin !== req.nextUrl.origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return NextResponse.json({ error: "JSONが必要です" }, { status: 415 });
  }
  const raw = await req.text();
  if (raw.length > 16_384) return NextResponse.json({ error: "設定が長すぎます" }, { status: 400 });
  let settings;
  let apiKey: string | null | undefined;
  try {
    const body = JSON.parse(raw);
    settings = normalizeJevModelSettings(body?.settings);
    apiKey = body.apiKey;
    if (apiKey !== undefined && apiKey !== null) {
      if (typeof apiKey !== "string" || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey.trim())) {
        throw new Error("APIキーが不正です");
      }
      apiKey = apiKey.trim();
    }
  } catch (error) {
    // JSON parser messages can contain submitted secrets; only expose our validation errors.
    return NextResponse.json({ error: error instanceof SyntaxError ? "JSONが不正です" : error instanceof Error ? error.message : "設定が不正です" }, { status: 400 });
  }
  try {
    await saveJevModelSettings(settings, apiKey);
    return NextResponse.json(await getJevModelSettingsDto());
  } catch {
    return NextResponse.json({ error: "Jevモデル設定を保存できません" }, { status: 500 });
  }
}
