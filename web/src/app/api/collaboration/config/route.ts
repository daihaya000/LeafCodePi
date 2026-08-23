import { NextRequest, NextResponse } from "next/server";
import {
  loadCollaborationConfig,
  writeCollaborationConfig,
} from "@/lib/collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configErrorMessage(error?: string): string {
  if (!error) return "協調設定が不正です";
  if (error.includes("must be an object")) return "設定はオブジェクトである必要があります";
  if (error.includes("mode is required")) return "モードは必須です";
  if (error.includes("strict or permissive")) return "モードは strict（厳格）または permissive（緩和）です";
  if (error.includes("timing and activity")) return "時間・件数の値が範囲外です";
  if (error.includes("at least heartbeatMs")) return "リース TTL と無応答判定はハートビート以上にしてください";
  return error;
}

export async function GET() {
  const snapshot = loadCollaborationConfig();
  return NextResponse.json({
    ...snapshot,
    error: snapshot.error ? configErrorMessage(snapshot.error) : undefined,
  });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const snapshot = writeCollaborationConfig(body);
  if (!snapshot.valid) {
    return NextResponse.json(
      { ...snapshot, error: configErrorMessage(snapshot.error) },
      { status: 400 },
    );
  }
  return NextResponse.json(snapshot);
}
