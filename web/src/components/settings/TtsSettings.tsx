"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { TtsConfigDto } from "@/lib/tts-config";

const DEFAULT_FORM: TtsConfigDto = {
  enabled: false,
  voice: "",
  rate: 0,
  url: "",
};

type ServerStatus = { running: boolean; url?: string; error?: string };

export function TtsSettings() {
  const [form, setForm] = useState<TtsConfigDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [serverBusy, setServerBusy] = useState(false);

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
    const optimistic = { ...form, ...patch };
    setForm(optimistic);
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

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">読み上げ (TTS)</h3>
      <p className="mt-1 text-xs text-muted">
        Bot / エージェントの発言を読み上げます。既定は Windows SAPI。HTTP URL を入れると Qwen3-TTS などのサーバーへ切り替えます。変更は次のエージェント開始から反映されます。
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
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">音声名（SAPI / HTTP voice）</span>
          <input
            type="text"
            value={current.voice}
            disabled={!ready || busy}
            placeholder="ramuchi / Microsoft Haruka Desktop"
            aria-label="TTS 音声名"
            onChange={(event) => setForm({ ...current, voice: event.target.value })}
            onBlur={() => {
              if (!ready || form === null) return;
              void save({ voice: form.voice });
            }}
            className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-60"
          />
        </label>

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

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">HTTP 合成 URL（空なら SAPI）</span>
          <input
            type="url"
            value={current.url}
            disabled={!ready || busy}
            placeholder="http://127.0.0.1:8080/tts"
            aria-label="TTS HTTP URL"
            onChange={(event) => setForm({ ...current, url: event.target.value })}
            onBlur={() => {
              if (!ready || form === null) return;
              void save({ url: form.url });
            }}
            className="h-9 w-full rounded-lg border border-border bg-bg px-3 font-mono text-sm text-text outline-none focus:border-border-strong disabled:opacity-60"
          />
          <span className="text-[11px] text-muted">
            `/tts` または OpenAI 互換の `/v1/audio/speech`。同梱サーバーは{" "}
            <code className="rounded bg-surface-2 px-1">extensions/leafcode-tts/server</code>。
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2">
          <span className="text-sm text-muted">Qwen3-TTS サーバー（Windows / ROCm）</span>
          <span className="text-sm text-text" aria-live="polite">
            {server === null ? "確認中" : server.running ? "稼働中" : "停止"}
          </span>
          <Button size="sm" disabled={serverBusy || server?.running === true} onClick={() => void startServer()}>
            起動
          </Button>
          <Button variant="ghost" size="sm" disabled={serverBusy} onClick={() => checkServer()}>
            状態確認
          </Button>
          {server?.error && <span className="text-[11px] text-muted">{server.error}</span>}
        </div>
      </div>

      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
