import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/agents-md";
import {
  readLeafCodeMemorySettings,
  writeLeafCodeMemorySettings,
} from "@/lib/leafcode-memory-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(readLeafCodeMemorySettings());
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as unknown;
    return NextResponse.json(writeLeafCodeMemorySettings(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "メモリ設定を保存できません" },
      { status: errorStatus(error) },
    );
  }
}
