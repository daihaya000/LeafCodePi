import { NextRequest, NextResponse } from "next/server";
import {
  getPushoverSettingsDto,
  PushoverEnvManagedError,
  savePushoverSettings,
  type PushoverSettingsPatch,
} from "@/lib/pushover-config";
import { notifyPushoverCompletion } from "@/lib/pushover";
import { rejectUnauthorizedTransfer, transferNoStore as noStore } from "@/lib/pi/transfer-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_PATTERN = /^[A-Za-z0-9]+$/;
const DEVICE_PATTERN = /^[A-Za-z0-9_. -]*$/;

function responseError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: noStore });
}

function rejectRequest(req: NextRequest): NextResponse | null {
  if (req.headers.get("sec-fetch-site") === "cross-site") return responseError("許可されない接続元です", 403);
  return rejectUnauthorizedTransfer(req);
}

function parsePatch(value: unknown): PushoverSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("設定形式が不正です");
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !["token", "user", "device", "enabled"].includes(key))) {
    throw new Error("設定項目が不正です");
  }
  const patch: PushoverSettingsPatch = {};
  for (const key of ["token", "user"] as const) {
    if (!(key in body)) continue;
    const item = body[key];
    if (item === null) patch[key] = null;
    else if (typeof item === "string" && KEY_PATTERN.test(item.trim()) && item.trim().length <= 128) {
      patch[key] = item.trim();
    } else throw new Error(`${key} の形式が不正です`);
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new Error("enabled の形式が不正です");
    patch.enabled = body.enabled;
  }
  if ("device" in body) {
    const item = body.device;
    if (item === null) patch.device = null;
    else if (typeof item === "string" && item.trim().length <= 100 && DEVICE_PATTERN.test(item.trim())) {
      patch.device = item.trim() || null;
    } else throw new Error("device の形式が不正です");
  }
  return patch;
}

export async function GET(req: NextRequest) {
  const denied = rejectRequest(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await getPushoverSettingsDto(), { headers: noStore });
  } catch {
    return responseError("Pushover設定を取得できません", 500);
  }
}

export async function PUT(req: NextRequest) {
  const denied = rejectRequest(req);
  if (denied) return denied;
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return responseError("JSONが必要です", 415);
  }
  if (Number(req.headers.get("content-length")) > 2048) return responseError("設定が長すぎます", 413);
  let patch: PushoverSettingsPatch;
  try {
    const raw = await req.text();
    if (raw.length > 2048) return responseError("設定が長すぎます", 413);
    patch = parsePatch(JSON.parse(raw));
  } catch {
    // JSON parse errors may contain a submitted key; never reflect them.
    return responseError("Pushover設定の形式が不正です", 400);
  }
  try {
    await savePushoverSettings(patch);
    return NextResponse.json(await getPushoverSettingsDto(), { headers: noStore });
  } catch (error) {
    if (error instanceof PushoverEnvManagedError) return responseError(error.message, 409);
    return responseError("Pushover設定を保存できません", 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = rejectRequest(req);
  if (denied) return denied;
  try {
    const settings = await getPushoverSettingsDto();
    if (!settings.hasToken || !settings.hasUser) return responseError("トークンとUser Keyを先に設定してください", 400);
    if (!settings.enabled) return responseError("通知送信がオフです。フッターでオンにしてください", 409);
    if (!await notifyPushoverCompletion("iPhoneへの通知を確認", { title: "テスト通知" })) {
      return responseError("Pushoverへの送信に失敗しました。キーと接続を確認してください", 502);
    }
    return NextResponse.json({ sent: true }, { headers: noStore });
  } catch {
    return responseError("テスト通知を送信できません", 500);
  }
}
