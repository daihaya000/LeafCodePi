import { NextRequest, NextResponse } from "next/server";
import { getSetting, MAX_SETTING_VALUE_CHARS, setSetting } from "@/lib/pi/web-settings";
import {
  GENERATION_MODEL_SETTING_KEY,
  splitGenerationModel,
} from "@/lib/generation-model-key";
import {
  clampNotificationSoundVolume,
  isNotificationSoundType,
  MAX_NOTIFICATION_SOUND_VOLUME,
  MIN_NOTIFICATION_SOUND_VOLUME,
  NOTIFICATION_SOUND_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_VOLUME_SETTING_KEY,
} from "@/lib/notification-sound-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 本家 LeafCode の /api/settings/[key] 相当。許容キーを絞って任意上書きを防ぐ。 */
const ALLOWED_KEYS = new Set<string>([
  GENERATION_MODEL_SETTING_KEY,
  NOTIFICATION_SOUND_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_VOLUME_SETTING_KEY,
]);

function validateValue(key: string, value: string): string | null {
  if (key === GENERATION_MODEL_SETTING_KEY) {
    const model = splitGenerationModel(value);
    return model ? `${model.providerID}::${model.modelID}` : null;
  }
  if (key === NOTIFICATION_SOUND_TYPE_SETTING_KEY) {
    return isNotificationSoundType(value) ? value : null;
  }
  if (key === NOTIFICATION_SOUND_VOLUME_SETTING_KEY) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return null;
    const clamped = clampNotificationSoundVolume(volume);
    return clamped >= MIN_NOTIFICATION_SOUND_VOLUME &&
      clamped <= MAX_NOTIFICATION_SOUND_VOLUME
      ? String(clamped)
      : null;
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  if (!ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ error: "unknown setting key" }, { status: 400 });
  }
  return NextResponse.json({ value: getSetting(key) });
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  if (!ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ error: "unknown setting key" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { value?: unknown }
    | null;
  if (!body || typeof body !== "object" || !("value" in body)) {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }
  const { value } = body;
  if (value !== null && typeof value !== "string") {
    return NextResponse.json(
      { error: "value must be a string or null" },
      { status: 400 },
    );
  }
  if (typeof value === "string" && value.length > MAX_SETTING_VALUE_CHARS) {
    return NextResponse.json(
      { error: `value exceeds ${MAX_SETTING_VALUE_CHARS} characters` },
      { status: 400 },
    );
  }
  // 値はキー毎のバリデーションを通ったものだけ保存（null は削除）。
  if (typeof value === "string") {
    const valid = validateValue(key, value);
    if (valid === null) {
      return NextResponse.json({ error: "invalid value" }, { status: 400 });
    }
    setSetting(key, valid);
  } else {
    setSetting(key, null);
  }
  return NextResponse.json({ value: getSetting(key) });
}
