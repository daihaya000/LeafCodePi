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
  isTitleAutoUpdateEnabledSetting,
  isTitleAutoUpdateFrequency,
  TITLE_AUTO_UPDATE_ENABLED_SETTING_KEY,
  TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY,
} from "@/lib/title-auto-update-settings";
import {
  clampNotificationSoundVolume,
  isNotificationSoundType,
  MAX_NOTIFICATION_SOUND_VOLUME,
  MIN_NOTIFICATION_SOUND_VOLUME,
  NOTIFICATION_SOUND_BOT_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_VOLUME_SETTING_KEY,
} from "@/lib/notification-sound-settings";
import {
  AUTO_MODEL_ENABLED_SETTING_KEY,
  isAutoOptimizeMode,
  normalizeAutoRouteConfig,
} from "@/lib/auto-model";
import {
  JEV_COMPACTION_ENABLED_SETTING_KEY,
  JEV_COMPACTION_THRESHOLD_SETTING_KEY,
  parseJevCompactionThreshold,
} from "@/lib/jev-compaction-settings";
import {
  AUTO_JEV_ENABLED_SETTING_KEY,
  AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY,
  isAutoJevMinConfidence,
} from "@/lib/auto-jev-settings";
import { BOT_DEFAULT_PERMISSION_KEY, BOT_DEFAULT_THINKING_KEY, BOT_DEFAULT_PERMISSION_VALUES, BOT_DEFAULT_THINKING_VALUES } from "@/lib/bot-settings";
import { PINNED_TASKS_SETTING_KEY, parsePinnedTaskIds } from "@/lib/sidebar-settings";
import { AUTO_ARCHIVE_DAYS_SETTING_KEY, isAutoArchiveDaysOption } from "@/lib/auto-archive-settings";
import {
  COMPOSER_PROMPT_PRESETS_SETTING_KEY,
  parseComposerPromptPresets,
} from "@/lib/composer-prompt-presets-schema";
import {
  parseSessionLabels,
  SESSION_LABEL_JEV_SETTING_KEY,
  SESSION_LABELS_SETTING_KEY,
} from "@/lib/session-label-settings";
import {
  CODEXBAR_WIDGET_SETTING_KEY,
  isWidgetSettingKey,
  SYSMON_WIDGET_SETTING_KEY,
  validateWidgetSettingValue,
} from "@/lib/widget-settings";
import { AUTO_AGENT_ENABLED_SETTING_KEY } from "@/lib/default-agent";
import {
  COMPOSER_DEFAULTS_SETTING_KEY,
  normalizeComposerDefaults,
} from "@/lib/composer-defaults";
import {
  clampScrollButtonOpacity,
  SCROLL_BUTTON_OPACITY_SETTING_KEY,
} from "@/lib/scroll-button-opacity";
import {
  clampPlaybackRate,
  clampPlaybackVolume,
  TTS_PLAYBACK_RATE_SETTING_KEY,
  TTS_PLAYBACK_VOLUME_SETTING_KEY,
} from "@/lib/tts-playback";

/** task-panes.ts / reasoning-translation.ts はクライアント依存が重いので、キーだけ同値で持つ。 */
export const TASK_PANE_PREFER_NEW_SETTING_KEY = "task-pane-prefer-new";
export const REASONING_TRANSLATION_MODE_SETTING_KEY = "reasoning-translation-mode";

/** 本家 LeafCode の /api/settings/[key] 相当。許容キーを絞って任意上書きを防ぐ。 */
export const ALLOWED_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
  "auto-optimize",
  AUTO_MODEL_ENABLED_SETTING_KEY,
  "auto-show-model",
  "auto-route-overrides",
  AUTO_JEV_ENABLED_SETTING_KEY,
  AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY,
  AUTO_AGENT_ENABLED_SETTING_KEY,
  JEV_COMPACTION_ENABLED_SETTING_KEY,
  JEV_COMPACTION_THRESHOLD_SETTING_KEY,
  "auto-agent-prompt",
  BOT_DEFAULT_PERMISSION_KEY,
  BOT_DEFAULT_THINKING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  NOTIFICATION_SOUND_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_BOT_TYPE_SETTING_KEY,
  NOTIFICATION_SOUND_VOLUME_SETTING_KEY,
  COMPACTION_ACTION_SETTING_KEY,
  COMPACTION_THRESHOLD_SETTING_KEY,
  TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY,
  TITLE_AUTO_UPDATE_ENABLED_SETTING_KEY,
  AUTO_ARCHIVE_DAYS_SETTING_KEY,
  PINNED_TASKS_SETTING_KEY,
  COMPOSER_PROMPT_PRESETS_SETTING_KEY,
  SESSION_LABELS_SETTING_KEY,
  SESSION_LABEL_JEV_SETTING_KEY,
  CODEXBAR_WIDGET_SETTING_KEY,
  SYSMON_WIDGET_SETTING_KEY,
  COMPOSER_DEFAULTS_SETTING_KEY,
  SCROLL_BUTTON_OPACITY_SETTING_KEY,
  TASK_PANE_PREFER_NEW_SETTING_KEY,
  REASONING_TRANSLATION_MODE_SETTING_KEY,
  TTS_PLAYBACK_RATE_SETTING_KEY,
  TTS_PLAYBACK_VOLUME_SETTING_KEY,
]);

function normalizedGenerationModelValue(value: string): string | null {
  const knownAccountIds = listAccounts().map((account) => account.id);
  const model = splitGenerationModel(value, knownAccountIds);
  if (!model) return null;
  return `${model.accountId ? `${model.accountId}::` : ""}${model.providerID}::${model.modelID}`;
}

function finiteNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** キー毎に検証・正規化した保存値を返す。不正値は null。 */
export function validateSettingValue(key: string, value: string): string | null {
  if (key === BOT_DEFAULT_PERMISSION_KEY) {
    return BOT_DEFAULT_PERMISSION_VALUES.includes(value as never) ? value : null;
  }
  if (key === BOT_DEFAULT_THINKING_KEY) {
    return BOT_DEFAULT_THINKING_VALUES.includes(value as never) ? value : null;
  }
  if (key === "auto-optimize") {
    return isAutoOptimizeMode(value) ? value : null;
  }
  if (key === AUTO_MODEL_ENABLED_SETTING_KEY) {
    return value === "0" || value === "1" ? value : null;
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
  if (key === AUTO_AGENT_ENABLED_SETTING_KEY) {
    return value === "0" || value === "1" ? value : null;
  }
  if (key === AUTO_JEV_ENABLED_SETTING_KEY) {
    return value === "1" ? value : null;
  }
  if (key === AUTO_JEV_MIN_CONFIDENCE_SETTING_KEY) {
    const minConfidence = Number(value);
    return isAutoJevMinConfidence(minConfidence) ? String(minConfidence) : null;
  }
  if (key === JEV_COMPACTION_ENABLED_SETTING_KEY) {
    return value === "1" ? value : null;
  }
  if (key === JEV_COMPACTION_THRESHOLD_SETTING_KEY) {
    const threshold = parseJevCompactionThreshold(value);
    return String(threshold) === value ? value : null;
  }
  if (key === "auto-agent-prompt") {
    return value.trim() ? value : null;
  }
  if (key === COMPOSER_PROMPT_PRESETS_SETTING_KEY) {
    const presets = parseComposerPromptPresets(value);
    return presets === null ? null : JSON.stringify(presets);
  }
  if (isWidgetSettingKey(key)) {
    return validateWidgetSettingValue(key, value);
  }
  if (key === PINNED_TASKS_SETTING_KEY) {
    const ids = parsePinnedTaskIds(value);
    return ids === null ? null : JSON.stringify(ids);
  }
  if (key === AUTO_ARCHIVE_DAYS_SETTING_KEY) {
    return isAutoArchiveDaysOption(value) ? value : null;
  }
  if (key === SESSION_LABELS_SETTING_KEY) {
    const labels = parseSessionLabels(value);
    return labels === null ? null : JSON.stringify(labels);
  }
  if (key === SESSION_LABEL_JEV_SETTING_KEY) {
    return value === "0" ? value : null;
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
  if (key === TITLE_AUTO_UPDATE_FREQUENCY_SETTING_KEY) {
    const frequency = Number(value);
    return isTitleAutoUpdateFrequency(frequency) ? String(frequency) : null;
  }
  if (key === TITLE_AUTO_UPDATE_ENABLED_SETTING_KEY) {
    return isTitleAutoUpdateEnabledSetting(value) ? value : null;
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
  if (key === NOTIFICATION_SOUND_TYPE_SETTING_KEY || key === NOTIFICATION_SOUND_BOT_TYPE_SETTING_KEY) {
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
  if (key === COMPOSER_DEFAULTS_SETTING_KEY) {
    try {
      return JSON.stringify(normalizeComposerDefaults(JSON.parse(value)));
    } catch {
      return null;
    }
  }
  if (key === SCROLL_BUTTON_OPACITY_SETTING_KEY) {
    const opacity = finiteNumber(value);
    return opacity === null ? null : String(clampScrollButtonOpacity(opacity));
  }
  if (key === TASK_PANE_PREFER_NEW_SETTING_KEY) {
    return value === "0" || value === "1" ? value : null;
  }
  if (key === REASONING_TRANSLATION_MODE_SETTING_KEY) {
    return value === "original" || value === "bilingual" || value === "translated" ? value : null;
  }
  if (key === TTS_PLAYBACK_RATE_SETTING_KEY) {
    const rate = finiteNumber(value);
    return rate === null ? null : String(clampPlaybackRate(rate));
  }
  if (key === TTS_PLAYBACK_VOLUME_SETTING_KEY) {
    const volume = finiteNumber(value);
    return volume === null ? null : String(clampPlaybackVolume(volume));
  }
  return null;
}
