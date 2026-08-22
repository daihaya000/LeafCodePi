"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { isLoopbackHost } from "@/lib/loopback";
import {
  DEFAULT_LLAMA_SERVER_SETTINGS,
  findLlamaModelPreset,
  isLlamaServerSettings,
  isLlamaSpecComboBroken,
  LLAMA_SERVER_EFFORTS,
  LLAMA_SERVER_SPEC_TYPES,
  type LlamaServerEffort,
  type LlamaServerSettings,
  type LlamaServerSpecType,
  parseLlamaServerSettings,
} from "@/lib/llama-server-settings";

/**
 * llama-server lifecycle status returned by the host control plane via the
 * BFF. `running` is authoritative (live /health OR a live listener); `pid` is
 * the owned cmd.exe PID the host spawned (may be dead after the bat exits).
 */
type LlamaServerStatus = {
  running: boolean;
  pid: number | null;
  listeningPids: number[];
  health: string | null;
};

const POLL_INTERVAL_MS = 3000;
const START_HEALTH_BUDGET_MS = 120_000;
const START_POLL_INTERVAL_MS = 1000;
const LLAMA_SERVER_UI_PORT = 8081;

async function fetchStatus(): Promise<LlamaServerStatus | null> {
  try {
    return await getJson<LlamaServerStatus>("/api/llama-server/status");
  } catch {
    return null;
  }
}

export function LlamaServerSettings() {
  const [status, setStatus] = useState<LlamaServerStatus | null>(null);
  const [config, setConfig] = useState<LlamaServerSettings>(DEFAULT_LLAMA_SERVER_SETTINGS);
  const [actionBusy, setActionBusy] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** False until the persisted config has been loaded, so the initial read
   *  does not trigger an immediate save-back of identical values. */
  const hydratedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /**
   * List the GGUF files under `dir` for the launch-model dropdown. Called with
   * an empty `dir` too: the response still carries the bat's fallback model, so
   * the "既定" entry can name it.
   */
  const loadModels = useCallback(async (dir: string) => {
    const trimmed = dir.trim();
    setModelsBusy(true);
    setModelsNote(null);
    try {
      const res = await getJson<{ models?: string[]; defaultModel?: string | null }>(
        "/api/llama-server/models",
        { dir: trimmed || undefined },
      );
      if (!mountedRef.current) return;
      const found = res.models ?? [];
      setModels(found);
      setDefaultModel(res.defaultModel ?? null);
      if (trimmed && found.length === 0) {
        setModelsNote("この保存先に .gguf が見つかりません");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setModels([]);
      setModelsNote(err instanceof Error ? err.message : "モデル一覧を取得できません");
    } finally {
      if (mountedRef.current) setModelsBusy(false);
    }
  }, []);

  // Load persisted settings from the server on mount.
  useEffect(() => {
    let cancelled = false;
    void getJson<{ value: string | null }>("/api/settings/llama-server-config")
      .then((res) => {
        if (cancelled) return;
        const parsed = parseLlamaServerSettings(res.value);
        setConfig(parsed);
        hydratedRef.current = true;
        void loadModels(parsed.modelDir);
      })
      .catch(() => {
        // Defaults are fine if the setting has never been saved.
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [loadModels]);

  // Auto-save with debounce: every edit is persisted shortly after the user
  // stops typing, like the other settings tabs. Saved values apply at the
  // next server start; a start already in flight keeps its own snapshot.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void sendJson("/api/settings/llama-server-config", {
        value: JSON.stringify(config),
      }, "PUT")
        .then(() => {
          if (mountedRef.current) setMessage("設定を保存しました");
        })
        .catch((err: unknown) => {
          if (mountedRef.current) {
            setError(
              err instanceof Error ? err.message : "設定の保存に失敗しました",
            );
          }
        });
    }, 600);
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [config]);

  // Poll status while the component is mounted.
  const refreshStatus = useCallback(async () => {
    const s = await fetchStatus();
    if (mountedRef.current) setStatus(s);
  }, []);

  useEffect(() => {
    void refreshStatus();
    pollRef.current = setInterval(() => void refreshStatus(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshStatus]);

  const startServer = async () => {
    if (actionBusy) return;
    setActionBusy("start");
    setError(null);
    setMessage(null);
    if (specBroken) {
      setActionBusy(null);
      setError("このモデルは推測デコード非対応です。「高速化」を「なし」に変更してください。");
      return;
    }
    try {
      const res = await sendJson<{ ok?: boolean; pid?: number | null; error?: string }>(
        "/api/llama-server/start",
        config,
      );
      if (!res.ok) {
        throw new Error(res.error ?? "起動に失敗しました");
      }
      // Poll until the server reports healthy (the bat itself polls /health,
      // but we confirm from the BFF side too).
      const deadline = Date.now() + START_HEALTH_BUDGET_MS;
      let becameHealthy = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
        if (!mountedRef.current) return;
        const s = await fetchStatus();
        if (s?.running && s.health === "ok") {
          becameHealthy = true;
          break;
        }
      }
      await refreshStatus();
      if (!mountedRef.current) return;
      if (becameHealthy) {
        try {
          const preferred =
            config.modelFile.trim()
              ? config.modelFile.replace(/\\/g, "/").split("/").pop()?.replace(/\.gguf$/i, "")
              : undefined;
          const loaded = await sendJson<{ ok?: boolean; modelId?: string; error?: string }>(
            "/api/llama-server/ensure-loaded",
            { preferredId: preferred },
          );
          if (loaded.ok) {
            setMessage(
              loaded.modelId
                ? `llama-server を起動し、モデルをロードしました（${loaded.modelId}）`
                : "llama-server を起動しました",
            );
          } else {
            setMessage("llama-server は起動しましたが、モデルの自動ロードに失敗しました");
            setError(loaded.error ?? "ensure-loaded failed");
          }
        } catch (err) {
          setMessage("llama-server は起動しましたが、モデルの自動ロードに失敗しました");
          setError(err instanceof Error ? err.message : "ensure-loaded failed");
        }
      } else {
        setError("llama-server の起動確認がタイムアウトしました。ステータスを確認してください。");
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "起動に失敗しました");
      }
    } finally {
      if (mountedRef.current) setActionBusy(null);
    }
  };

  const stopServer = async () => {
    if (actionBusy) return;
    setActionBusy("stop");
    setError(null);
    setMessage(null);
    try {
      await sendJson("/api/llama-server/stop", {});
      // Give the soft/hard kill a moment, then re-check.
      await new Promise((r) => setTimeout(r, 1500));
      if (!mountedRef.current) return;
      await refreshStatus();
      if (mountedRef.current) setMessage("llama-server を停止しました");
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "停止に失敗しました");
      }
    } finally {
      if (mountedRef.current) setActionBusy(null);
    }
  };

  const running = status?.running === true;
  const preset = findLlamaModelPreset(config.modelFile);
  const presetMismatched =
    preset !== null &&
    (config.effort !== preset.settings.effort ||
      (config.specType ?? "") !== preset.settings.specType ||
      config.contextLength !== preset.settings.contextLength);
  const specBroken = isLlamaSpecComboBroken(config.modelFile, config.specType);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">ローカル LLM (llama-server)</h2>
          <p className="mt-1 text-xs text-muted">
            llama-server-load.bat 経由でローカルモデルを起動・停止します。起動時にモデルがロードされ、停止時にアンロードされます。
          </p>
        </div>
        <Badge tone={running ? "success" : status ? "danger" : "neutral"}>
          {running ? "実行中" : status ? "停止" : "不明"}
        </Badge>
      </div>

      {status && (
        <dl className="mb-3 grid grid-cols-[6rem_1fr] gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted">health</dt>
          <dd className="font-mono text-xs">{status.health ?? "—"}</dd>
          <dt className="text-muted">PID</dt>
          <dd className="font-mono text-xs">{status.pid ?? "—"}</dd>
          <dt className="text-muted">listeners</dt>
          <dd className="font-mono text-xs">
            {status.listeningPids.length > 0 ? status.listeningPids.join(", ") : "—"}
          </dd>
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          busy={actionBusy === "start"}
          disabled={actionBusy !== null || running}
          onClick={() => void startServer()}
        >
          起動
        </Button>
        <Button
          type="button"
          size="sm"
          variant="danger"
          busy={actionBusy === "stop"}
          disabled={actionBusy !== null || !running}
          onClick={() => void stopServer()}
        >
          停止
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!running}
          onClick={() => {
            // Same access path as this WebUI: on the host the page is already
            // on 127.0.0.1 (localhost-redirect), on a remote device the
            // hostname is the Tailscale/LAN address the server was reached on.
            const hostname =
              typeof window !== "undefined" && !isLoopbackHost(window.location.hostname)
                ? window.location.hostname
                : "127.0.0.1";
            window.open(`http://${hostname}:${LLAMA_SERVER_UI_PORT}/`, "_blank", "noopener");
          }}
        >
          WebUI を開く
        </Button>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-semibold">起動設定</h3>
        <div className="mb-3 grid gap-3">
          {/* Hints sit outside the <label> as aria-describedby so the
              accessible name stays the field title alone. */}
          <div>
            <label htmlFor="llama-cpp-path" className="mb-1 block text-sm text-muted">
              llama.cpp インストール先
            </label>
            <input
              id="llama-cpp-path"
              type="text"
              spellCheck={false}
              aria-describedby="llama-cpp-path-hint"
              placeholder="C:\tools\llama.cpp"
              value={config.llamaCppPath}
              disabled={actionBusy !== null}
              onChange={(e) => setConfig((c) => ({ ...c, llamaCppPath: e.target.value }))}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            />
            <span id="llama-cpp-path-hint" className="mt-1 block text-[11px] text-faint">
              フォルダ指定で llama-server.exe を補完します。空欄なら bat の既定値。
            </span>
          </div>

          <div>
            <label htmlFor="llama-model-dir" className="mb-1 block text-sm text-muted">
              モデル保存先
            </label>
            <div className="flex gap-2">
              <input
                id="llama-model-dir"
                type="text"
                spellCheck={false}
                aria-describedby="llama-model-dir-hint"
                placeholder="C:\Users\me\models\llm"
                value={config.modelDir}
                disabled={actionBusy !== null}
                onChange={(e) => setConfig((c) => ({ ...c, modelDir: e.target.value }))}
                onBlur={() => void loadModels(config.modelDir)}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                busy={modelsBusy}
                disabled={actionBusy !== null}
                onClick={() => void loadModels(config.modelDir)}
              >
                再取得
              </Button>
            </div>
            <span id="llama-model-dir-hint" className="mt-1 block text-[11px] text-faint">
              絶対パスで指定。直下と 2 階層下までの .gguf を探します。
            </span>
          </div>

          <div>
            <label htmlFor="llama-model-file" className="mb-1 block text-sm text-muted">
              起動するモデル
            </label>
            <select
              id="llama-model-file"
              value={config.modelFile}
              disabled={actionBusy !== null}
              onChange={(e) => setConfig((c) => ({ ...c, modelFile: e.target.value }))}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            >
              <option value="">
                {defaultModel ? `既定: ${defaultModel}` : "既定 (bat の設定)"}
              </option>
              {/* A saved model stays selectable even when the listing is empty
                  or the folder is temporarily unreachable. */}
              {(config.modelFile && !models.includes(config.modelFile)
                ? [config.modelFile, ...models]
                : models
              ).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            {modelsNote && (
              <span className="mt-1 block text-[11px] text-warning" role="status">
                {modelsNote}
              </span>
            )}
            {preset && presetMismatched && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2">
                <span className="text-[11px] text-muted">
                  {preset.label} 向けの推奨設定があります
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={actionBusy !== null}
                  onClick={() => setConfig((c) => ({ ...c, ...preset.settings }))}
                >
                  推奨設定を適用
                </Button>
              </div>
            )}
            {specBroken && (
              <p
                className="mt-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger"
                role="alert"
              >
                このモデルは推測デコード非対応のため、draft-mtp のままでは起動できません。「高速化」を「なし」にしてください。
              </p>
            )}
          </div>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              aria-label="リモートアクセスを許可（LAN・Tailscale）"
              checked={config.llamaServerHost === "0.0.0.0"}
              disabled={actionBusy !== null}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  llamaServerHost: e.target.checked ? "0.0.0.0" : "127.0.0.1",
                }))
              }
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span>
              リモートアクセスを許可（LAN・Tailscale）
              <span className="mt-1 block text-[11px] text-faint">
                llama-server を 0.0.0.0 にバインドし、他の端末から WebUI
                （http://&lt;ホストのIP&gt;:8081）を開けるようにします。オフの場合は
                このPCのみ（127.0.0.1）。反映にはサーバーの再起動が必要です。
              </span>
            </span>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-sm text-muted">思考の深さ</span>
            <select
              value={config.effort}
              disabled={actionBusy !== null}
              onChange={(e) =>
                setConfig((c) => ({ ...c, effort: e.target.value as LlamaServerEffort }))
              }
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            >
              {LLAMA_SERVER_EFFORTS.map((effort) => (
                <option key={effort || "none"} value={effort}>
                  {effort === "" ? "なし（思考テンプレなし）" : { low: "低", medium: "中", xhigh: "特高" }[effort]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-muted">高速化（推測デコード）</span>
            <select
              value={config.specType ?? ""}
              disabled={actionBusy !== null}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  specType: e.target.value as LlamaServerSpecType,
                }))
              }
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            >
              {LLAMA_SERVER_SPEC_TYPES.map((spec) => (
                <option key={spec || "off"} value={spec}>
                  {spec === "" ? "なし" : spec}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-faint">
              draft-mtp は MTP 込み GGUF（Qwen3.8 等）専用。非対応モデルでは起動しません
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-muted">コンテキスト長</span>
            <input
              type="number"
              min={4096}
              max={1_000_000}
              step={4096}
              value={config.contextLength}
              disabled={actionBusy !== null}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  contextLength: Number(e.target.value) || c.contextLength,
                }))
              }
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            />
            <div className="mt-1 flex gap-1" role="group" aria-label="コンテキスト長プリセット">
              {[32_768, 65_536, 131_072].map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => setConfig((c) => ({ ...c, contextLength: n }))}
                  className={`rounded-md border px-2 py-0.5 text-[11px] outline-none disabled:opacity-40 ${
                    config.contextLength === n
                      ? "border-border-strong bg-surface-3 font-medium"
                      : "border-border text-muted hover:border-border-strong"
                  }`}
                >
                  {Math.round(n / 1024)}K
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-muted">同時処理数</span>
            <input
              type="number"
              min={1}
              max={16}
              value={config.parallel}
              disabled={actionBusy !== null}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  parallel: Number(e.target.value) || c.parallel,
                }))
              }
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-faint">
          変更は自動で保存され、次回起動時に反映されます
        </p>
      </div>

      {message && (
        <p
          className="mt-3 rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-xs text-success"
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          className="mt-3 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </p>
      )}
    </div>
  );
}