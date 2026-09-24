/** サイドバーウィジェット（CodexBar / システム使用率）の表示設定。/api/settings/[key] に JSON で保存する。 */
export const CODEXBAR_WIDGET_SETTING_KEY = "codexbar-widget";
export const SYSMON_WIDGET_SETTING_KEY = "sysmon-widget";

export type CodexBarWidgetSettings = {
  collapsed?: boolean;
  twoColumn?: boolean;
  /** 折りたたみ中の provider / instance ID。未保存なら undefined。 */
  providerCollapsed?: Record<string, true>;
};

export type SysmonWidgetSettings = {
  collapsed?: boolean;
  twoColumn?: boolean;
  hidden?: string[];
};

const MAX_IDS = 100;
const MAX_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function pickBooleans<T extends { collapsed?: boolean; twoColumn?: boolean }>(
  src: Record<string, unknown>,
  out: T,
): T {
  if (typeof src.collapsed === "boolean") out.collapsed = src.collapsed;
  if (typeof src.twoColumn === "boolean") out.twoColumn = src.twoColumn;
  return out;
}

export function normalizeCodexBarWidgetSettings(value: unknown): CodexBarWidgetSettings | null {
  if (!isRecord(value)) return null;
  const out = pickBooleans(value, {} as CodexBarWidgetSettings);
  if (isRecord(value.providerCollapsed)) {
    const map: Record<string, true> = {};
    for (const [id, v] of Object.entries(value.providerCollapsed).slice(0, MAX_IDS)) {
      if (v === true && isId(id)) map[id] = true;
    }
    out.providerCollapsed = map;
  }
  return out;
}

export function normalizeSysmonWidgetSettings(value: unknown): SysmonWidgetSettings | null {
  if (!isRecord(value)) return null;
  const out = pickBooleans(value, {} as SysmonWidgetSettings);
  if (Array.isArray(value.hidden)) {
    out.hidden = [...new Set(value.hidden.filter(isId))].slice(0, MAX_IDS);
  }
  return out;
}

const NORMALIZERS: Record<string, (value: unknown) => object | null> = {
  [CODEXBAR_WIDGET_SETTING_KEY]: normalizeCodexBarWidgetSettings,
  [SYSMON_WIDGET_SETTING_KEY]: normalizeSysmonWidgetSettings,
};

export function isWidgetSettingKey(key: string): boolean {
  return key in NORMALIZERS;
}

/** API 保存前の検証。正規化済み JSON 文字列、または不正時 null。 */
export function validateWidgetSettingValue(key: string, raw: string): string | null {
  const normalize = NORMALIZERS[key];
  if (!normalize) return null;
  try {
    const normalized = normalize(JSON.parse(raw));
    return normalized ? JSON.stringify(normalized) : null;
  } catch {
    return null;
  }
}
