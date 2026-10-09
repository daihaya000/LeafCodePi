import {  ConfigurationRequest as NextRequest, ConfigurationResponse as NextResponse  } from "../../../http";
import { getSetting, MAX_SETTING_VALUE_CHARS, setSetting } from "@/lib/pi/web-settings";
import { ALLOWED_SETTING_KEYS as ALLOWED_KEYS, validateSettingValue as validateValue } from "@/lib/pi/setting-validation";
import { isAutoOptimizeMode } from "@/lib/auto-model";
import { AUTO_AGENT_SYSTEM_INSTRUCTION } from "@/lib/auto-agent";
import { GIT_COMMIT_AUTHOR_SETTING_KEY } from "@/lib/git-commit-author";
import { getMachineName } from "@/lib/machine-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ key: string }> },
) {
  const { key } = await context.params;
  if (!ALLOWED_KEYS.has(key)) {
    return NextResponse.json({ error: "unknown setting key" }, { status: 400 });
  }
  const value = getSetting(key);
  if (key === GIT_COMMIT_AUTHOR_SETTING_KEY) {
    return NextResponse.json({ value, machineName: getMachineName() });
  }
  return key === "auto-agent-prompt"
    ? NextResponse.json({ value, defaultPrompt: AUTO_AGENT_SYSTEM_INSTRUCTION })
    : NextResponse.json({ value });
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
  const value = body.value === "" ? null : body.value;
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
  // The owner command checkpoints the saved revision before applying live settings.
  const stored = getSetting(key);
  return key === "auto-agent-prompt"
    ? NextResponse.json({ value: stored, defaultPrompt: AUTO_AGENT_SYSTEM_INSTRUCTION })
    : NextResponse.json({ value: stored });
}
