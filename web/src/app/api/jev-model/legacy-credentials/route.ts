import { NextRequest, NextResponse } from "next/server";
import { isCrossOriginRequest } from "@/lib/same-origin";
import { deleteLegacyJevCredential, listLegacyJevCredentials } from "@/lib/pi/jev-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ credentials: await listLegacyJevCredentials() });
  } catch {
    return NextResponse.json({ error: "旧Jev互換キーを取得できません" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (isCrossOriginRequest(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return NextResponse.json({ error: "JSONが必要です" }, { status: 415 });
  }
  const raw = await req.text();
  if (raw.length > 512) return NextResponse.json({ error: "指定が長すぎます" }, { status: 400 });
  let providerId: string;
  try {
    const body = JSON.parse(raw);
    if (typeof body?.providerId !== "string" || !/^jev-compatible-[0-9a-f]{64}$/.test(body.providerId)) {
      throw new Error("旧Jev互換キーの指定が不正です");
    }
    providerId = body.providerId;
  } catch {
    return NextResponse.json({ error: "旧Jev互換キーの指定が不正です" }, { status: 400 });
  }
  try {
    await deleteLegacyJevCredential(providerId);
    return NextResponse.json({ credentials: await listLegacyJevCredentials() });
  } catch {
    return NextResponse.json({ error: "旧Jev互換キーを削除できません" }, { status: 500 });
  }
}
