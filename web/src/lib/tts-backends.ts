/** Preset backends for the TTS settings dropdown. Keeps url/voice in sync with tts.json. */

export type TtsBackendId = "sapi" | "aivis" | "qwen" | "custom";

export type TtsVoiceOption = {
  id: string;
  label: string;
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
    defaultVoice: "1455757728",
    voices: [
      { id: "1455757728", label: "ramuchi / ノーマル" },
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

export function voiceLabel(backendId: TtsBackendId, voice: string): string {
  const backend = getTtsBackend(backendId);
  const match = backend?.voices.find((option) => option.id === voice);
  if (match) return match.label;
  if (backendId === "custom") return voice.trim() || "（未設定）";
  return voice.trim() || backend?.voices[0]?.label || "（未設定）";
}
