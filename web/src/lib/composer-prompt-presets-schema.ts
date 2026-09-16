export type ComposerPromptPreset = {
  /** Candidate label and the token part used after `/prompt:`. */
  name: string;
  /** Text inserted into the composer when the preset is selected. */
  prompt: string;
};

export const COMPOSER_PROMPT_PRESETS_SETTING_KEY = "composer-prompt-presets";
export const MAX_COMPOSER_PROMPT_PRESETS = 8;
export const MAX_COMPOSER_PROMPT_PRESET_NAME_CHARS = 32;
export const MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS = 1200;
/** Keep the JSON below the shared settings endpoint's 4 KiB limit. */
export const MAX_COMPOSER_PROMPT_PRESETS_VALUE_CHARS = 4096;

const INVALID_PRESET_NAME = /[\s/@]/;

function asPreset(value: unknown): ComposerPromptPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (
    !name ||
    name.length > MAX_COMPOSER_PROMPT_PRESET_NAME_CHARS ||
    INVALID_PRESET_NAME.test(name) ||
    !prompt ||
    prompt.length > MAX_COMPOSER_PROMPT_PRESET_PROMPT_CHARS
  ) {
    return null;
  }
  return { name, prompt };
}

/**
 * Normalize data before it reaches localStorage. Invalid entries are ignored so
 * a single malformed old value cannot disable the composer.
 */
export function normalizeComposerPromptPresets(raw: unknown): ComposerPromptPreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: ComposerPromptPreset[] = [];
  const names = new Set<string>();
  for (const value of raw) {
    const preset = asPreset(value);
    if (!preset) continue;
    const key = preset.name.toLocaleLowerCase();
    if (names.has(key)) continue;
    const next = [...presets, preset];
    if (JSON.stringify(next).length > MAX_COMPOSER_PROMPT_PRESETS_VALUE_CHARS) break;
    names.add(key);
    presets.push(preset);
    if (presets.length >= MAX_COMPOSER_PROMPT_PRESETS) break;
  }
  return presets;
}

/** Parse and validate a server value; unlike normalize, malformed entries reject the whole value. */
export function parseComposerPromptPresets(raw: string): ComposerPromptPreset[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_COMPOSER_PROMPT_PRESETS) return null;
    const normalized = normalizeComposerPromptPresets(parsed);
    if (normalized.length !== parsed.length) return null;
    return normalized;
  } catch {
    return null;
  }
}

/** Expand a manually typed `/prompt:name` token before sending as a normal prompt. */
export function expandComposerPromptPresets(
  value: string,
  presets: ReadonlyArray<Pick<ComposerPromptPreset, "name"> & { prompt?: string; insertText?: string }>,
): string {
  if (!value || presets.length === 0) return value;
  const byName = new Map(
    presets.flatMap((preset) => {
      const prompt = preset.prompt ?? preset.insertText;
      return prompt === undefined ? [] : [[preset.name.toLocaleLowerCase(), prompt] as const];
    }),
  );
  return value.replace(/(^|\s)\/prompt:([^\s/@]+)/gi, (match, boundary: string, name: string) => {
    const prompt = byName.get(name.toLocaleLowerCase());
    return prompt === undefined ? match : `${boundary}${prompt}`;
  });
}
