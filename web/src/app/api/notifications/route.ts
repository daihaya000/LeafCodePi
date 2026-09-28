import { NextRequest, NextResponse } from "next/server";
import { readPushoverNotificationEnabled, savePushoverNotificationEnabled } from "@/lib/pushover-config";
import { rejectUnauthorizedTransfer, transferNoStore as noStore } from "@/lib/pi/transfer-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

function denied(req: NextRequest): NextResponse | null {
  if (req.headers.get("sec-fetch-site") === "cross-site") return errorResponse("許可されない接続元です", 403);
  return rejectUnauthorizedTransfer(req);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = denied(req);
  if (rejection) return rejection;
  try {
    return NextResponse.json({ enabled: readPushoverNotificationEnabled() }, { headers: noStore });
  } catch {
    return errorResponse("通知設定を取得できません", 500);
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const rejection = denied(req);
  if (rejection) return rejection;
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return errorResponse("JSONが必要です", 415);
  }
  let value: unknown;
  try {
    if (Number(req.headers.get("content-length")) > 128) return errorResponse("設定が長すぎます", 413);
    const text = await req.text();
    if (text.length > 128) return errorResponse("設定が長すぎます", 413);
    value = JSON.parse(text);
  } catch {
    return errorResponse("通知設定の形式が不正です", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return errorResponse("通知設定の形式が不正です", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") return errorResponse("通知設定の形式が不正です", 400);
  try {
    savePushoverNotificationEnabled(body.enabled);
    return NextResponse.json({ enabled: readPushoverNotificationEnabled() }, { headers: noStore });
  } catch {
    return errorResponse("通知設定を保存できません", 500);
  }
}
