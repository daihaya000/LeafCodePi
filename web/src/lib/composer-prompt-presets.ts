import { createSettingSync } from "@/lib/setting-sync";
import {
  COMPOSER_PROMPT_PRESETS_SETTING_KEY,
  parseComposerPromptPresets,
  type ComposerPromptPreset,
  normalizeComposerPromptPresets,
} from "@/lib/composer-prompt-presets-schema";

export * from "@/lib/composer-prompt-presets-schema";

export const COMPOSER_PROMPT_PRESETS_EVENT = "webui:composer-prompt-presets";

const sync = createSettingSync({
  storageKey: "leafcodepi.composerPromptPresets",
  serverPath: `/api/settings/${COMPOSER_PROMPT_PRESETS_SETTING_KEY}`,
  eventName: COMPOSER_PROMPT_PRESETS_EVENT,
});

function parse(raw: string | null): ComposerPromptPreset[] {
  if (!raw) return [];
  return parseComposerPromptPresets(raw) ?? [];
}

export function readComposerPromptPresets(): ComposerPromptPreset[] {
  return parse(sync.read());
}

export function hasStoredComposerPromptPresets(): boolean {
  return sync.read() !== null;
}

/** Update local state synchronously and mirror the canonical JSON to the server. */
export function writeComposerPromptPresets(presets: readonly ComposerPromptPreset[]): void {
  const value = JSON.stringify(normalizeComposerPromptPresets(presets));
  sync.write(value);
  void sync.writeToServer(value);
}

export async function readComposerPromptPresetsFromServer(): Promise<ComposerPromptPreset[] | null> {
  const raw = await sync.readFromServer();
  return raw === null ? null : parse(raw);
}

export function subscribeComposerPromptPresets(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(COMPOSER_PROMPT_PRESETS_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_PROMPT_PRESETS_EVENT, listener);
}
