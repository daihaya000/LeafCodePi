import { getJson, sendJson } from "./client";
import { createSettingSync } from "./setting-sync";
import { PROJECT_ICON_COLORS, type ProjectIconColor } from "./types";

export const SESSION_LABELS_SETTING_KEY = "session-labels";
export const SESSION_LABELS_EVENT = "webui:session-labels";
const SESSION_LABELS_STORAGE_KEY = "webui:session-labels";
/** "0" turns Jev off for labels; unset keeps Jev on. The title model's label line still applies. */
export const SESSION_LABEL_JEV_SETTING_KEY = "session-label-jev";
const SESSION_LABEL_JEV_PATH = `/api/settings/${SESSION_LABEL_JEV_SETTING_KEY}`;

export function isSessionLabelJevEnabled(value: string | null | undefined): boolean {
  return value !== "0";
}

export const MAX_SESSION_LABELS = 12;
export const MAX_SESSION_LABEL_ID_CHARS = 64;
export const MAX_SESSION_LABEL_NAME_CHARS = 20;
export const MAX_SESSION_LABEL_HINT_CHARS = 200;
/** Keep the JSON below the shared settings endpoint's 4 KiB limit. */
export const MAX_SESSION_LABELS_VALUE_CHARS = 4096;

export type SessionLabel = {
  id: string;
  name: string;
  hint: string;
  color: ProjectIconColor;
};

/** Used when the setting was never saved. An empty array means "labels disabled". */
export const DEFAULT_SESSION_LABELS: readonly SessionLabel[] = [
  { id: "debug", name: "デバッグ", hint: "不具合・エラー・失敗の調査や修正", color: "red" },
  { id: "code", name: "コード", hint: "実装・修正・リファクタなどコードを変更する作業", color: "blue" },
  { id: "research", name: "調査", hint: "変更を伴わない調査・比較・仕様やコードの読解", color: "purple" },
  { id: "chat", name: "チャット", hint: "相談・計画・質問など具体的な作業を伴わない会話", color: "teal" },
  { id: "ops", name: "運用", hint: "ビルド・デプロイ・git・環境設定などの運用操作", color: "orange" },
];

function asLabel(value: unknown): SessionLabel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const hint = typeof record.hint === "string" ? record.hint.trim() : "";
  const color = record.color;
  if (!id || id.length > MAX_SESSION_LABEL_ID_CHARS) return null;
  if (!name || name.length > MAX_SESSION_LABEL_NAME_CHARS) return null;
  if (hint.length > MAX_SESSION_LABEL_HINT_CHARS) return null;
  if (typeof color !== "string" || !PROJECT_ICON_COLORS.includes(color as ProjectIconColor)) {
    return null;
  }
  return { id, name, hint, color: color as ProjectIconColor };
}

/** Normalize before storing locally. Invalid entries are dropped, never fatal. */
export function normalizeSessionLabels(raw: unknown): SessionLabel[] {
  if (!Array.isArray(raw)) return [];
  const labels: SessionLabel[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const value of raw) {
    const label = asLabel(value);
    if (!label || seenIds.has(label.id) || seenNames.has(label.name)) continue;
    const next = [...labels, label];
    if (JSON.stringify(next).length > MAX_SESSION_LABELS_VALUE_CHARS) break;
    seenIds.add(label.id);
    seenNames.add(label.name);
    labels.push(label);
    if (labels.length >= MAX_SESSION_LABELS) break;
  }
  return labels;
}

/** Parse a server value; unlike normalize, a malformed entry rejects the whole value. */
export function parseSessionLabels(raw: string): SessionLabel[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_SESSION_LABELS) return null;
    if (parsed.some((value) => asLabel(value) === null)) return null;
    return normalizeSessionLabels(parsed);
  } catch {
    return null;
  }
}

/** null (never configured) falls back to the defaults; "[]" disables labelling. */
export function resolveSessionLabels(raw: string | null | undefined): SessionLabel[] {
  if (raw === null || raw === undefined || raw === "") return [...DEFAULT_SESSION_LABELS];
  return parseSessionLabels(raw) ?? [...DEFAULT_SESSION_LABELS];
}

export function findSessionLabel(
  labels: readonly SessionLabel[],
  id: string | null | undefined,
): SessionLabel | undefined {
  return id ? labels.find((label) => label.id === id) : undefined;
}

const sync = createSettingSync({
  storageKey: SESSION_LABELS_STORAGE_KEY,
  serverPath: `/api/settings/${SESSION_LABELS_SETTING_KEY}`,
  eventName: SESSION_LABELS_EVENT,
});

export function readSessionLabels(): SessionLabel[] {
  return resolveSessionLabels(sync.read());
}

export function hasStoredSessionLabels(): boolean {
  return sync.read() !== null;
}

export function writeSessionLabels(labels: readonly SessionLabel[]): void {
  sync.write(JSON.stringify(normalizeSessionLabels(labels)));
}

export function subscribeSessionLabels(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_LABELS_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(SESSION_LABELS_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SESSION_LABELS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * サーバ値（正本）でローカルキャッシュを更新する。旧実装はローカル値があると
 * サーバを読まず、他PCでの変更が反映されなかった。
 * バッジ等は起動中1回の取得を共有し、設定画面は fresh で毎回取り直す。
 */
let hydrationPromise: Promise<void> | null = null;

async function applySessionLabelsFromServer(): Promise<void> {
  const value = await sync.readFromServer();
  if (value !== null && parseSessionLabels(value) !== null && value !== sync.read()) sync.write(value);
}

export function hydrateSessionLabelsFromServer(options?: { fresh?: boolean }): Promise<void> {
  if (options?.fresh) return applySessionLabelsFromServer();
  hydrationPromise ??= applySessionLabelsFromServer();
  return hydrationPromise;
}

/** Only the server reads this toggle, so the server value is the single source of truth. */
export async function readSessionLabelJevEnabledFromServer(): Promise<boolean> {
  const data = await getJson<{ value: string | null }>(SESSION_LABEL_JEV_PATH, undefined, { coalesce: false });
  return isSessionLabelJevEnabled(data?.value);
}

export async function writeSessionLabelJevEnabled(enabled: boolean): Promise<void> {
  await sendJson(SESSION_LABEL_JEV_PATH, { value: enabled ? null : "0" }, "PUT");
}

export async function writeSessionLabelsToServer(labels: readonly SessionLabel[]): Promise<void> {
  await sync.writeToServer(JSON.stringify(normalizeSessionLabels(labels)));
}
