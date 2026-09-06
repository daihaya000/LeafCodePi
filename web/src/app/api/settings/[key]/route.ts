import { NextRequest, NextResponse } from "next/server";
import { getSetting, MAX_SETTING_VALUE_CHARS, setSetting } from "@/lib/pi/web-settings";
import { listAccounts } from "@/lib/accounts";
import {
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
  isGenerationModelEffort,
  splitGenerationModel,
} from "@/lib/generation-model-key";
import {
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
} from "@/lib/compaction-settings";
import {
  clampNotificationSoundVolume,
  isNotificationSoundType,
  MAX_NOTIFICATION_SOUND_VOLUME,
  MIN_NOTIFICATION_SOUND_VOLUME,
  NOTIFICATION_SOUND_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_VOLUME_SETTING_KEY,
} from "@/lib/notification-sound-settings";
import {
  isAutoOptimizeMode,
  normalizeAutoRouteConfig,
} from "@/lib/auto-model";
import { BOT_DEFAULT_PERMISSION_KEY, BOT_DEFAULT_THINKING_KEY, BOT_DEFAULT_PERMISSION_VALUES, BOT_DEFAULT_THINKING_VALUES } from "@/lib/bot-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 本家 LeafCode の /api/settings/[key] 相当。許容キーを絞って任意上書きを防ぐ。 */
const ALLOWED_KEYS = new Set<string>([
  "auto-optimize",
  "auto-show-model",
  "auto-route-overrides",
  "auto-agent-prompt",
  BOT_DEFAULT_PERMISSION_KEY,
  BOT_DEFAULT_THINKING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  NOTIFICATION_SOUND_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_VOLUME_SETTING_KEY,
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
]);

function normalizedGenerationModelValue(value: string): string | null {
  const knownAccountIds = listAccounts().map((account) => account.id);
  const model = splitGenerationModel(value, knownAccountIds);
  if (!model) return null;
  return `${model.accountId ? `${model.accountId}::` : ""}${model.providerID}::${model.modelID}`;
}

function validateValue(key: string, value: string): string | null {
  if (key === BOT_DEFAULT_PERMISSION_KEY) {
    return BOT_DEFAULT_PERMISSION_VALUES.includes(value as never) ? value : null;
  }
  if (key === BOT_DEFAULT_THINKING_KEY) {
    return BOT_DEFAULT_THINKING_VALUES.includes(value as never) ? value : null;
  }
  if (key === "auto-optimize") {
    return isAutoOptimizeMode(value) ? value : null;
  }
  if (key === "auto-show-model") {
    return value === "1" ? value : null;
  }
  if (key === "auto-route-overrides") {
    try {
      return JSON.stringify(normalizeAutoRouteConfig(JSON.parse(value)));
    } catch {
      return null;
    }
  }
  if (key === "auto-agent-prompt") {
    return value.trim() ? value : null;
  }
  if (key === COMPACTION_ACTION_SETTING_KEY) {
    return value === "suggest" || value === "auto" || value === "off" ? value : null;
  }
  if (key === COMPACTION_THRESHOLD_SETTING_KEY) {
    const threshold = Number(value);
    return Number.isInteger(threshold) && threshold >= 70 && threshold <= 95
      ? String(threshold)
      : null;
  }
  if (key === GENERATION_FALLBACK_MODEL_SETTING_KEY) {
    return normalizedGenerationModelValue(value);
  }
  if (key === GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY) {
    return isGenerationModelEffort(value) ? value : null;
  }
  if (key === GENERATION_MODEL_SETTING_KEY) {
    return normalizedGenerationModelValue(value);
  }
  if (key === GENERATION_MODEL_EFFORT_SETTING_KEY) {
    return isGenerationModelEffort(value) ? value : null;
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
  if (value === "") {
    setSetting(key, null);
    return NextResponse.json({ value: getSetting(key) });
  }
  if (typeof value === "string") {
    if (key === "auto-optimize" && !isAutoOptimizeMode(value)) {
      return NextResponse.json(
        { error: "auto-optimize must be cost, balanced or intelligence" },
        { status: 400 },
      );
    }
    if (key === "auto-show-model" && value !== "1") {
      return NextResponse.json(
        { error: "auto-show-model must be 1 or empty" },
        { status: 400 },
      );
    }
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
