/**
 * 起動時に Composer へ適用する既定値（モデル / effort=Auto最適化方針 / エージェント）。
 *
 * localStorage が同期読み取りの正本、サーバ settings 表が永続バックアップ。
 * AppShell はブート時に同期読み取りだけを使うため、別デバイスで保存した値は
 * 設定画面を一度開いた次のブートから反映される。
 */

import { createSettingSync } from "@/lib/setting-sync";
import {
  AUTO_MODEL_VALUE,
  isAutoOptimizeMode,
  type AutoOptimizeMode,
} from "@/lib/auto-model";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";

export type ComposerDefaults = {
  /** モデル value（`auto` または `[accountId::]provider::model`）。 */
  model: string;
  /** Auto モデル時の最適化方針（composer の effort 欄）。 */
  autoOptimize: AutoOptimizeMode;
  /** エージェント名（`__auto__` で Auto）。 */
  agent: string;
};

export const COMPOSER_DEFAULTS_SETTING_KEY = "composer-defaults";
export const COMPOSER_DEFAULTS_EVENT = "webui:composer-defaults";

/** 設定が無い場合の組み込み既定値（従来のハードコード値と同じ）。 */
export const BUILTIN_COMPOSER_DEFAULTS: ComposerDefaults = Object.freeze({
  model: AUTO_MODEL_VALUE,
  autoOptimize: "balanced",
  agent: AUTO_AGENT_VALUE,
});

const sync = createSettingSync({
  storageKey: "leafcodepi.composerDefaults",
  serverPath: `/api/settings/${COMPOSER_DEFAULTS_SETTING_KEY}`,
  eventName: COMPOSER_DEFAULTS_EVENT,
});

export function normalizeComposerDefaults(raw: unknown): ComposerDefaults {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return BUILTIN_COMPOSER_DEFAULTS;
  }
  const object = raw as Record<string, unknown>;
  const model =
    typeof object.model === "string" && object.model.trim()
      ? object.model.trim()
      : BUILTIN_COMPOSER_DEFAULTS.model;
  const agent =
    typeof object.agent === "string" && object.agent.trim()
      ? object.agent.trim()
      : BUILTIN_COMPOSER_DEFAULTS.agent;
  return {
    model,
    autoOptimize: isAutoOptimizeMode(object.autoOptimize)
      ? object.autoOptimize
      : BUILTIN_COMPOSER_DEFAULTS.autoOptimize,
    agent,
  };
}

function parse(raw: string | null): ComposerDefaults {
  if (!raw) return BUILTIN_COMPOSER_DEFAULTS;
  try {
    return normalizeComposerDefaults(JSON.parse(raw));
  } catch {
    return BUILTIN_COMPOSER_DEFAULTS;
  }
}

/** 同期読み取り（ブート時に使う）。 */
export function readComposerDefaults(): ComposerDefaults {
  return parse(sync.read());
}

export function hasStoredComposerDefaults(): boolean {
  return sync.read() !== null;
}

/** localStorage 即時反映 + サーバへミラー。 */
export function writeComposerDefaults(defaults: ComposerDefaults): void {
  const value = JSON.stringify(normalizeComposerDefaults(defaults));
  sync.write(value);
  void sync.writeToServer(value);
}

export async function readComposerDefaultsFromServer(): Promise<ComposerDefaults | null> {
  const raw = await sync.readFromServer();
  return raw === null ? null : parse(raw);
}

export function subscribeComposerDefaults(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(COMPOSER_DEFAULTS_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_DEFAULTS_EVENT, listener);
}
