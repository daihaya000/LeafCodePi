export type ComposerPromptPreset = string;

export const COMPOSER_PROMPT_PRESETS_SETTING_KEY = "composer-prompt-presets";
export const MAX_COMPOSER_PROMPT_PRESETS = 8;
export const MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS = 1200;
/** Keep the JSON below the shared settings endpoint's 4 KiB limit. */
export const MAX_COMPOSER_PROMPT_PRESETS_VALUE_CHARS = 4096;

/** Accept the previous object shape so existing saved presets survive the migration. */
function asPreset(value: unknown): ComposerPromptPreset | null {
  const rawPrompt = typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).prompt
      : null;
  if (typeof rawPrompt !== "string") return null;
  const prompt = rawPrompt.trim();
  return prompt && prompt.length <= MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS ? prompt : null;
}

/**
 * Normalize data before it reaches localStorage. Invalid entries are ignored so
 * a single malformed old value cannot disable the composer.
 */
export function normalizeComposerPromptPresets(raw: unknown): ComposerPromptPreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: ComposerPromptPreset[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const prompt = asPreset(value);
    if (prompt === null || seen.has(prompt)) continue;
    const next = [...presets, prompt];
    if (JSON.stringify(next).length > MAX_COMPOSER_PROMPT_PRESETS_VALUE_CHARS) break;
    seen.add(prompt);
    presets.push(prompt);
    if (presets.length >= MAX_COMPOSER_PROMPT_PRESETS) break;
  }
  return presets;
}

/** Parse and validate a server value; unlike normalize, malformed entries reject the whole value. */
export function parseComposerPromptPresets(raw: string): ComposerPromptPreset[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_COMPOSER_PROMPT_PRESETS) return null;
    if (parsed.some((value) => asPreset(value) === null)) return null;
    return normalizeComposerPromptPresets(parsed);
  } catch {
    return null;
  }
}
