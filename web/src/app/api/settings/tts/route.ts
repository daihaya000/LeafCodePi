import { NextRequest, NextResponse } from "next/server";
import { readTtsConfig, writeTtsConfig, type TtsConfigDto } from "@/lib/tts-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dto(config = readTtsConfig()): TtsConfigDto {
  return config;
}

export async function GET() {
  return NextResponse.json(dto());
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Partial<TtsConfigDto> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON オブジェクトが必要です" }, { status: 400 });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled は boolean です" }, { status: 400 });
  }
  if (body.voice !== undefined && typeof body.voice !== "string") {
    return NextResponse.json({ error: "voice は string です" }, { status: 400 });
  }
  if (body.url !== undefined && typeof body.url !== "string") {
    return NextResponse.json({ error: "url は string です" }, { status: 400 });
  }
  if (body.rate !== undefined && (typeof body.rate !== "number" || !Number.isFinite(body.rate))) {
    return NextResponse.json({ error: "rate は number です" }, { status: 400 });
  }
  return NextResponse.json(dto(writeTtsConfig(body)));
}
