"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, Play } from "lucide-react";
import { Button, GhostSelect, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  TTS_BACKENDS,
  backendLabel,
  detectTtsBackend,
  getTtsBackend,
  voiceLabel,
  type TtsBackendId,
} from "@/lib/tts-backends";
import type { TtsConfigDto } from "@/lib/tts-config";
import { speakText, stopSpeaking } from "@/lib/tts-playback";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  readPlaybackRate,
  readPlaybackVolume,
  writePlaybackRate,
  writePlaybackVolume,
} from "@/lib/tts-playback";

const DEFAULT_FORM: TtsConfigDto = {
  enabled: false,
  voice: "",
  rate: 10,
  url: "",
};

type ServerStatus = { running: boolean; url?: string; error?: string; port?: number };

export function TtsSettings() {
  const [form, setForm] = useState<TtsConfigDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(readPlaybackRate);
  const [playbackVolume, setPlaybackVolume] = useState(readPlaybackVolume);
  const [testError, setTestError] = useState<string | null>(null);

  // 再生中に設定画面を閉じたら止める。
  useEffect(() => () => stopSpeaking(), []);

  const playTest = () => {
    setTestError(null);
    speakText("読み上げのテストです。", { onError: setTestError });
  };

  const checkServer = useCallback(() => {
    void getJson<ServerStatus>("/api/settings/tts/server")
      .then(setServer)
      .catch((err) => setServer({ running: false, error: err instanceof Error ? err.message : "状態取得に失敗" }));
  }, []);

  const startServer = async () => {
    setServerBusy(true);
    try {
      await sendJson<{ started: boolean }>("/api/settings/tts/server", {}, "POST");
      setServer({ running: false, error: "起動中（初回はモデル読込で数分かかります）" });
    } catch (err) {
      setServer({ running: false, error: err instanceof Error ? err.message : "起動に失敗しました" });
    } finally {
      setServerBusy(false);
    }
  };

  const stopServer = async () => {
    setServerBusy(true);
    try {
      const result = await sendJson<{ stopped: boolean; error?: string }>(
        "/api/settings/tts/server",
        {},
        "DELETE",
      );
      setServer({ running: false, error: result.stopped ? undefined : result.error });
    } catch (err) {
      setServer({ running: false, error: err instanceof Error ? err.message : "停止に失敗しました" });
      checkServer();
    } finally {
      setServerBusy(false);
    }
  };

  const reload = useCallback(() => {
    void getJson<TtsConfigDto>("/api/settings/tts")
      .then((result) => {
        setForm(result);
        setLoaded(true);
        setError(null);
      })
      .catch((err) => {
        setLoaded(true);
        setForm(null);
        setError(err instanceof Error ? err.message : "読み上げ設定の取得に失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
    checkServer();
  }, [reload, checkServer]);

  const save = async (patch: Partial<TtsConfigDto>) => {
    if (busy || form === null) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const previous = form;
    setForm({ ...form, ...patch });
    try {
      const result = await sendJson<TtsConfigDto>("/api/settings/tts", patch, "PATCH");
      setForm(result);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setForm(previous);
      setError(err instanceof Error ? err.message : "読み上げ設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const ready = loaded && form !== null;
  const current = form ?? DEFAULT_FORM;
  const backendId = detectTtsBackend(current.url);
  const backend = getTtsBackend(backendId);
  const voices = useMemo(() => backend?.voices ?? [], [backend]);
  const selectedVoice =
    voices.find((option) => option.id === current.voice)?.id ?? voices[0]?.id ?? current.voice;

  const applyBackend = (id: TtsBackendId) => {
    if (!ready || form === null) return;
    if (id === "custom") {
      // Keep current url/voice; just expose the free-form fields.
      if (backendId === "custom") return;
      void save({ url: current.url || "http://127.0.0.1:10101", voice: current.voice });
      return;
    }
    const next = getTtsBackend(id);
    if (!next) return;
    void save({ url: next.url, voice: next.defaultVoice });
  };

  const applyVoice = (voice: string) => {
    if (!ready || form === null) return;
    void save({ voice });
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">読み上げ (TTS)</h3>
      <p className="mt-1 text-xs text-muted">
        Bot / エージェントの発言を読み上げます。この全体スイッチはCLIとブラウザの両方に効きます。ブラウザのタスク／BotごとのON/OFFは各画面のヘッダーで切り替えます。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Switch
          checked={current.enabled}
          onChange={() => void save({ enabled: !current.enabled })}
          label="読み上げを有効にする"
          busy={busy || !loaded}
          disabled={!ready}
        />
        <span className="text-sm text-text" aria-live="polite">
          {!loaded ? "読込中" : form === null ? "不明" : current.enabled ? "有効" : "無効"}
        </span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
          再読込
        </Button>
        {saved && (
          <span className="text-xs text-muted" aria-live="polite">
            保存しました
          </span>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">バックエンド</span>
          <GhostSelect
            value={backendId}
            disabled={!ready || busy}
            aria-label="TTS バックエンド"
            icon={<AudioLines className="h-3.5 w-3.5" />}
            valueLabel={backendLabel(backendId)}
            onChange={(value) => applyBackend(value as TtsBackendId)}
            className="h-9 w-full max-w-md"
          >
            {TTS_BACKENDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
            <option value="custom">カスタム URL</option>
          </GhostSelect>
        </div>

        {backendId !== "custom" && voices.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">音声 / モデル</span>
            <GhostSelect
              value={selectedVoice}
              disabled={!ready || busy}
              aria-label="TTS 音声"
              icon={<AudioLines className="h-3.5 w-3.5" />}
              valueLabel={voiceLabel(backendId, selectedVoice)}
              onChange={applyVoice}
              className="h-9 w-full max-w-md"
            >
              {voices.map((option) => (
                <option key={option.id || "default"} value={option.id}>
                  {option.label}
                </option>
              ))}
            </GhostSelect>
          </div>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">音声名 / speaker id</span>
            <input
              type="text"
              value={current.voice}
              disabled={!ready || busy}
              placeholder="style id または SAPI 音声名"
              aria-label="TTS 音声名"
              onChange={(event) => setForm({ ...current, voice: event.target.value })}
              onBlur={() => {
                if (!ready || form === null) return;
                void save({ voice: form.voice });
              }}
              className="h-9 w-full max-w-md rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-60"
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">速度（SAPI -10..10）</span>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              value={current.rate}
              disabled={!ready || busy}
              aria-label="TTS 速度"
              aria-valuetext={String(current.rate)}
              onChange={(event) => {
                const rate = Number(event.target.value);
                setForm({ ...current, rate });
                void save({ rate });
              }}
              className="min-w-0 flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            />
            <output className="w-8 shrink-0 text-right font-mono text-sm text-text">{current.rate}</output>
          </span>
        </label>

        <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">話速（ブラウザ再生）</span>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <input
              type="range"
              min={MIN_PLAYBACK_RATE}
              max={MAX_PLAYBACK_RATE}
              step={0.1}
              value={playbackRate}
              disabled={!ready || busy}
              aria-label="読み上げの話速"
              aria-valuetext={`${playbackRate.toFixed(1)}倍`}
              onChange={(event) => setPlaybackRate(writePlaybackRate(Number(event.target.value)))}
              className="min-w-0 flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            />
            <output className="w-12 shrink-0 text-right font-mono text-sm text-text">{playbackRate.toFixed(1)}倍</output>
          </span>
        </label>

        <label className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-sm text-muted">音量（ブラウザ再生）</span>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={playbackVolume}
              disabled={!ready || busy}
              aria-label="読み上げの音量"
              aria-valuetext={`${playbackVolume}%`}
              onChange={(event) => setPlaybackVolume(writePlaybackVolume(Number(event.target.value)))}
              className="min-w-0 flex-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            />
            <output className="w-12 shrink-0 text-right font-mono text-sm text-text">{playbackVolume}%</output>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" disabled={!ready || busy} onClick={playTest}>
            <Play className="h-3.5 w-3.5" />
            テスト再生
          </Button>
          <span className="text-xs text-muted">現在のバックエンド・話速・音量で再生します</span>
          {testError && (
            <span className="text-xs text-danger" role="alert">
              {testError}
            </span>
          )}
        </div>

        {backendId === "custom" && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">HTTP 合成 URL（空なら SAPI）</span>
            <input
              type="url"
              value={current.url}
              disabled={!ready || busy}
              placeholder="http://127.0.0.1:10101"
              aria-label="TTS HTTP URL"
              onChange={(event) => setForm({ ...current, url: event.target.value })}
              onBlur={() => {
                if (!ready || form === null) return;
                void save({ url: form.url });
              }}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-border-strong disabled:opacity-60"
            />
          </label>
        )}

        {backendId !== "custom" && current.url && (
          <p className="font-mono text-[11px] text-muted">{current.url}</p>
        )}

        {(backendId === "qwen" || backendId === "custom") && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2">
            <span className="text-sm text-muted">Qwen3-TTS サーバー（Windows / ROCm・比較用）</span>
            <span className="text-sm text-text" aria-live="polite">
              {server === null ? "確認中" : server.running ? "稼働中" : "停止"}
            </span>
            <Button size="sm" disabled={serverBusy || server?.running === true} onClick={() => void startServer()}>
              起動
            </Button>
            <Button variant="ghost" size="sm" disabled={serverBusy} onClick={() => void stopServer()}>
              停止
            </Button>
            <Button variant="ghost" size="sm" disabled={serverBusy} onClick={() => checkServer()}>
              状態確認
            </Button>
            {server?.error && <span className="text-[11px] text-muted">{server.error}</span>}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
