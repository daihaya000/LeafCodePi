/** Preset backends for the TTS settings dropdown. Keeps url/voice in sync with tts.json. */

export type TtsBackendId = "sapi" | "aivis" | "qwen" | "custom";

export type TtsVoiceOption = {
  id: string;
  label: string;
};

export type TtsVoicesDto = {
  voices: TtsVoiceOption[];
};

export type TtsBackendPreset = {
  id: Exclude<TtsBackendId, "custom">;
  label: string;
  /** Empty = Windows SAPI. */
  url: string;
  defaultVoice: string;
  voices: TtsVoiceOption[];
};

/** Known engines used in this project. Ports match local.rocm.json / AivisSpeech defaults. */
export const TTS_BACKENDS: TtsBackendPreset[] = [
  {
    id: "sapi",
    label: "Windows SAPI",
    url: "",
    defaultVoice: "",
    voices: [{ id: "", label: "既定の SAPI 音声" }],
  },
  {
    id: "aivis",
    label: "AivisSpeech",
    url: "http://127.0.0.1:10101",
    defaultVoice: "871574624",
    voices: [
      // AIVMX model: 54e9ae01-4f5f-4443-85c6-8f625939729a
      { id: "871574624", label: "ramuchi / ノーマル" },
      // AIVMX model: 16ad30dd-739b-434c-8077-487d089b0751
      { id: "1257529344", label: "kanna / ノーマル" },
      { id: "888753760", label: "まお / ノーマル" },
      { id: "888753761", label: "まお / ふつー" },
      { id: "888753762", label: "まお / あまあま" },
      { id: "888753763", label: "まお / おちつき" },
      { id: "888753764", label: "まお / からかう" },
      { id: "888753765", label: "まお / せつなめ" },
      { id: "1878365376", label: "コハク / ノーマル" },
      { id: "1878365377", label: "コハク / あまあま" },
      { id: "1878365378", label: "コハク / せつなめ" },
      { id: "1878365379", label: "コハク / ねむたい" },
    ],
  },
  {
    id: "qwen",
    label: "Qwen3-TTS (ROCm)",
    url: "http://127.0.0.1:18080/v1/audio/speech",
    defaultVoice: "ramuchi",
    voices: [{ id: "ramuchi", label: "ramuchi（Qwen 参照クローン）" }],
  },
];

export function normalizeTtsUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function detectTtsBackend(url: string): TtsBackendId {
  const normalized = normalizeTtsUrl(url);
  if (!normalized) return "sapi";
  for (const backend of TTS_BACKENDS) {
    if (backend.id === "sapi") continue;
    if (normalizeTtsUrl(backend.url) === normalized) return backend.id;
  }
  return "custom";
}

export function getTtsBackend(id: TtsBackendId): TtsBackendPreset | null {
  if (id === "custom") return null;
  return TTS_BACKENDS.find((backend) => backend.id === id) ?? null;
}

export function backendLabel(id: TtsBackendId): string {
  if (id === "custom") return "カスタム URL";
  return getTtsBackend(id)?.label ?? id;
}

export function voiceLabel(
  backendId: TtsBackendId,
  voice: string,
  options?: readonly TtsVoiceOption[],
): string {
  const backend = getTtsBackend(backendId);
  const match = (options ?? backend?.voices)?.find((option) => option.id === voice);
  if (match) return match.label;
  if (backendId === "custom") return voice.trim() || "（未設定）";
  return voice.trim() || options?.[0]?.label || backend?.voices[0]?.label || "（未設定）";
}

/** Convert AivisSpeech's VOICEVOX-compatible /speakers response to UI options. */
export function parseAivisSpeakers(payload: unknown): TtsVoiceOption[] {
  if (!Array.isArray(payload)) return [];
  const options: TtsVoiceOption[] = [];
  const seen = new Set<string>();

  for (const speaker of payload) {
    if (!speaker || typeof speaker !== "object") continue;
    const speakerRecord = speaker as { name?: unknown; styles?: unknown };
    const speakerName = typeof speakerRecord.name === "string" ? speakerRecord.name.trim() : "";
    if (!Array.isArray(speakerRecord.styles)) continue;

    for (const style of speakerRecord.styles) {
      if (!style || typeof style !== "object") continue;
      const styleRecord = style as { id?: unknown; name?: unknown; type?: unknown };
      // AivisSpeech also exposes singing styles, which are not valid for /audio_query.
      if (styleRecord.type !== "talk") continue;
      const id = typeof styleRecord.id === "number" && Number.isSafeInteger(styleRecord.id)
        ? String(styleRecord.id)
        : typeof styleRecord.id === "string" ? styleRecord.id.trim() : "";
      if (!id || seen.has(id)) continue;
      const styleName = typeof styleRecord.name === "string" ? styleRecord.name.trim() : "";
      options.push({ id, label: [speakerName, styleName].filter(Boolean).join(" / ") || id });
      seen.add(id);
    }
  }

  return options;
}
