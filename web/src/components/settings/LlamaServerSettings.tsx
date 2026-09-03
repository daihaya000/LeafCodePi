"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { isLoopbackHost } from "@/lib/loopback";
import {
  DEFAULT_LLAMA_SERVER_PORT,
  DEFAULT_LLAMA_SERVER_SETTINGS,
  isLlamaSpecComboBroken,
  LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS,
  LLAMA_MODEL_PRESETS,
  LLAMA_SERVER_EFFORTS,
  LLAMA_SERVER_SPEC_TYPES,
  type LlamaServerEffort,
  type LlamaServerSettings,
  type LlamaServerSpecType,
} from "@/lib/llama-server-settings";

/**
 * llama-server lifecycle status returned by the host control plane via the
 * BFF. `running` is authoritative (live /health OR a live listener); `pid` is
 * the owned cmd.exe PID the host spawned (may be dead after the bat exits).
 */
type LlamaServerStatus = {
  running: boolean;
  pid: number | null;
  port?: number;
  listeningPids: number[];
  health: string | null;
};

const POLL_INTERVAL_MS = 3000;
const START_HEALTH_BUDGET_MS = 120_000;
const START_POLL_INTERVAL_MS = 1000;

async function fetchStatus(): Promise<LlamaServerStatus | null> {
  try {
    return await getJson<LlamaServerStatus>("/api/llama-server/status");
  } catch {
    return null;
  }
}

export function LlamaServerSettings(
  { active = true }: { active?: boolean } = {},
) {
  const [status, setStatus] = useState<LlamaServerStatus | null>(null);
  const [config, setConfig] = useState<LlamaServerSettings>(DEFAULT_LLAMA_SERVER_SETTINGS);
  const [actionBusy, setActionBusy] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  /** Explicitly chosen family; survives until the GGUF listing can resolve it
   *  into config.modelFile. Null = derive the family from the saved model. */
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const mountedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef(config);
  const persistedConfigRef = useRef(JSON.stringify(DEFAULT_LLAMA_SERVER_SETTINGS));
  /** False until the persisted config has been loaded, so the initial read
   *  does not trigger an immediate save-back of identical values. */
  const hydratedRef = useRef(false);
  /** 直列化キュー。PUTを並走させず1つずつ実行し、ネットワーク遅延の逆転で古い値が
   *  新しい値を上書きしないようにする。 */
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  configRef.current = config;

  const persistConfig = useCallback((
    nextConfig: LlamaServerSettings,
    announce: boolean,
  ): Promise<void> => {
    const operation = saveQueueRef.current.then(async () => {
      try {
        await sendJson("/api/settings/llama-server-config", {
          value: JSON.stringify(nextConfig),
        }, "PUT");
        persistedConfigRef.current = JSON.stringify(nextConfig);
        if (mountedRef.current && announce) setMessage("設定を保存しました");
      } catch (err: unknown) {
        if (mountedRef.current) {
          setError(
            err instanceof Error ? err.message : "設定の保存に失敗しました",
          );
        }
      }
    });
    saveQueueRef.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void persistConfig(configRef.current, false);
      }
    };
  }, [persistConfig]);

  /**
   * List the GGUF files under `dir` for the launch-model dropdown. Called with
   * an empty `dir` too: the response resolves the platform's fallback directory.
   */
  const loadModels = useCallback(async (dir: string) => {
    const trimmed = dir.trim();
    setModelsBusy(true);
    setModelsNote(null);
    try {
      const res = await getJson<{
        models?: string[];
        defaultModel?: string | null;
        dir?: string | null;
      }>("/api/llama-server/models", { dir: trimmed || undefined });
      if (!mountedRef.current) return;
      const found = res.models ?? [];
      setModels(found);
      setDefaultModel(res.defaultModel ?? null);
      // The API resolved an empty dir against the platform default; save it so
      // presets keep working across reloads.
      if (!trimmed && typeof res.dir === "string" && res.dir) {
        setConfig((c) => (c.modelDir ? c : { ...c, modelDir: res.dir as string }));
      }
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

  // Load persisted settings from the server on mount. The form stays
  // disabled (configLoaded=false) until this resolves so an edit made before
  // the GET response arrives cannot be silently overwritten by setConfig below.
  useEffect(() => {
    let cancelled = false;
    void getJson<{ parsed: LlamaServerSettings }>("/api/settings/llama-server-config")
      .then((res) => {
        if (cancelled) return;
        persistedConfigRef.current = JSON.stringify(res.parsed);
        setConfig(res.parsed);
        setSelectedFamily(null); // derive from the saved model first
        hydratedRef.current = true;
        setConfigLoaded(true);
        void loadModels(res.parsed.modelDir);
      })
      .catch(() => {
        // Defaults are fine if the setting has never been saved.
        persistedConfigRef.current = JSON.stringify(DEFAULT_LLAMA_SERVER_SETTINGS);
        hydratedRef.current = true;
        setConfigLoaded(true);
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
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const serialized = JSON.stringify(config);
    if (serialized === persistedConfigRef.current) return;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistConfig(config, true);
    }, 600);
  }, [config, persistConfig]);

  // Poll status while the component is mounted.
  const refreshStatus = useCallback(async () => {
    const s = await fetchStatus();
    if (mountedRef.current) setStatus(s);
  }, []);

  useEffect(() => {
    if (!active) return;
    // 非表示中はpollingを止めていたため、再表示直後の古いstatusで起動・停止を
    // 操作できないよう、確認中へ戻してから最新値を取得する。
    setStatus(null);
    void refreshStatus();
    pollRef.current = setInterval(() => void refreshStatus(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [active, refreshStatus]);

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
        // The prompt is applied to chat requests by the llama-server provider,
        // not by the process launcher. Keep it out of the host control payload.
        { ...config, systemPrompt: undefined },
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
  const selectedPreset =
    selectedFamily && selectedFamily !== "custom"
      ? LLAMA_MODEL_PRESETS.find((p) => p.key === selectedFamily) ?? null
      : null;
  const activePreset =
    selectedPreset ??
    (selectedFamily === "custom"
      ? null
      : LLAMA_MODEL_PRESETS.find(
          (p) =>
            p.match.test(config.modelFile) &&
            config.effort === p.settings.effort &&
            (config.specType ?? "") === p.settings.specType &&
            config.contextLength === p.settings.contextLength &&
            (config.cacheTypeK ?? "") === p.settings.cacheTypeK &&
            (config.cacheTypeV ?? "") === p.settings.cacheTypeV,
        ) ?? LLAMA_MODEL_PRESETS.find((p) => p.match.test(config.modelFile)) ?? null);
  /** The explicit choice wins so the dropdown does not snap back to カスタム
   *  while the GGUF listing is still empty. */
  const familyKey = selectedFamily ?? activePreset?.key ?? "custom";
  const presetMismatched =
    activePreset !== null &&
    (config.effort !== activePreset.settings.effort ||
      (config.specType ?? "") !== activePreset.settings.specType ||
      config.contextLength !== activePreset.settings.contextLength ||
      (config.cacheTypeK ?? "") !== activePreset.settings.cacheTypeK ||
      (config.cacheTypeV ?? "") !== activePreset.settings.cacheTypeV);
  const specBroken = isLlamaSpecComboBroken(config.modelFile, config.specType);
  // GET完了前の編集がeffectのsetConfigで上書きされないよう、読込完了まで起動設定フォーム全体を無効化する。
  const formDisabled = actionBusy !== null || !configLoaded;

  /** Pick a model family (or "custom"): applies the preset wholesale. The
   *  GGUF file itself resolves later, once `models` has loaded (see effect). */
  const selectModelFamily = (key: string) => {
    setSelectedFamily(key);
    if (key === "custom") {
      setShelfOpen(true);
      return;
    }
    const preset = LLAMA_MODEL_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setConfig((c) => {
      const modelFile =
        c.modelFile && preset.match.test(c.modelFile)
          ? c.modelFile
          : models.find((m) => preset.match.test(m));
      return modelFile
        ? { ...c, ...preset.settings, modelFile }
        : { ...c, ...preset.settings };
    });
  };

  // Late resolution: the family was picked before the GGUF listing arrived.
  useEffect(() => {
    if (!selectedFamily || selectedFamily === "custom" || models.length === 0) return;
    const preset = LLAMA_MODEL_PRESETS.find((p) => p.key === selectedFamily);
    if (!preset) return;
    setConfig((c) => {
      if (c.modelFile && preset.match.test(c.modelFile)) return c;
      const candidate = models.find((m) => preset.match.test(m));
      return candidate ? { ...c, modelFile: candidate } : c;
    });
  }, [selectedFamily, models]);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">ローカル LLM (llama-server)</h2>
          <p className="mt-1 text-xs text-muted">
            ローカルモデルを起動・停止します。起動時にモデルがロードされ、停止時にアンロードされます。
          </p>
        </div>
        <Badge tone={status === null ? "neutral" : running ? "success" : "danger"} pulse={status === null}>
          {status === null ? "確認中" : running ? "実行中" : "停止"}
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
          disabled={actionBusy !== null || running || status === null}
          onClick={() => void startServer()}
        >
          起動
        </Button>
        <Button
          type="button"
          size="sm"
          variant="danger"
          busy={actionBusy === "stop"}
          disabled={actionBusy !== null || !running || status === null}
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
            window.open(
              `http://${hostname}:${status?.port ?? DEFAULT_LLAMA_SERVER_PORT}/`,
              "_blank",
              "noopener",
            );
          }}
        >
          WebUI を開く
        </Button>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-semibold">起動設定</h3>
        <div>
          <label htmlFor="llama-model-family" className="mb-1 block text-sm text-muted">
            使用するモデル
          </label>
          <select
            id="llama-model-family"
            value={familyKey}
            disabled={formDisabled}
            aria-describedby="llama-model-family-hint"
            onChange={(e) => selectModelFamily(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
          >
            {LLAMA_MODEL_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="custom">カスタム（詳細設定）</option>
          </select>
          <span id="llama-model-family-hint" className="mt-1 block text-[11px] text-muted">
            {activePreset
              ? activePreset.description
              : "個別の GGUF やパラメータを使う場合に選択してください。"}
          </span>
        </div>

        {specBroken && (
          <p
            className="mt-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger"
            role="alert"
          >
            このモデルは推測デコード非対応のため、draft-mtp のままでは起動できません。詳細設定で「高速化」を「なし」にしてください。
          </p>
        )}

        <button
          type="button"
          aria-expanded={shelfOpen}
          disabled={!configLoaded}
          onClick={() => setShelfOpen((o) => !o)}
          className="mt-3 flex w-full items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted outline-none hover:border-border-strong focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex items-center gap-2">
            詳細設定
            {presetMismatched && (
              <Badge tone="neutral">カスタム値あり</Badge>
            )}
          </span>
          <ChevronDown
            size={16}
            className={`transition-transform ${shelfOpen ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>

        {shelfOpen && (
          <div className="mb-3 mt-3 grid gap-3 border-t border-border pt-3">
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
              placeholder="例: /opt/llama.cpp または C:\tools\llama.cpp"
              value={config.llamaCppPath}
              disabled={formDisabled}
              onChange={(e) => setConfig((c) => ({ ...c, llamaCppPath: e.target.value }))}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            />
            <span id="llama-cpp-path-hint" className="mt-1 block text-[11px] text-muted">
              フォルダ指定で実行ファイル（Windows: llama-server.exe / Linux・macOS: llama-server）を補完します。空欄なら環境変数/既定値。
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
                disabled={formDisabled}
                onChange={(e) => setConfig((c) => ({ ...c, modelDir: e.target.value }))}
                onBlur={() => void loadModels(config.modelDir)}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                busy={modelsBusy}
                disabled={formDisabled}
                onClick={() => void loadModels(config.modelDir)}
              >
                再取得
              </Button>
            </div>
            <span id="llama-model-dir-hint" className="mt-1 block text-[11px] text-muted">
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
              disabled={formDisabled}
              onChange={(e) => setConfig((c) => ({ ...c, modelFile: e.target.value }))}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            >
              <option value="">
                {defaultModel ? `既定: ${defaultModel}` : "既定 (サーバー設定)"}
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
          </div>

          <div>
            <label htmlFor="llama-system-prompt" className="mb-1 block text-sm text-muted">
              システムプロンプト
            </label>
            <textarea
              id="llama-system-prompt"
              rows={5}
              maxLength={LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS}
              aria-describedby="llama-system-prompt-hint"
              placeholder="例: 回答は日本語で、簡潔に説明してください。"
              value={config.systemPrompt}
              disabled={formDisabled}
              onChange={(e) => setConfig((c) => ({ ...c, systemPrompt: e.target.value }))}
              className="min-h-28 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-strong disabled:opacity-40"
            />
            <span id="llama-system-prompt-hint" className="mt-1 block text-[11px] text-muted">
              LeafCode の既定プロンプトに追加して、llama-server への各チャットリクエストに送信します。空欄なら追加しません。
            </span>
          </div>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              aria-label="リモートアクセスを許可（LAN・Tailscale）"
              checked={config.llamaServerHost === "0.0.0.0"}
              disabled={formDisabled}
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
              <span className="mt-1 block text-[11px] text-muted">
                llama-server を 0.0.0.0 にバインドし、他の端末から WebUI
                （http://&lt;ホストのIP&gt;:{status?.port ?? DEFAULT_LLAMA_SERVER_PORT}）を開けるようにします。オフの場合は
                このPCのみ（127.0.0.1）。反映にはサーバーの再起動が必要です。
              </span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-sm text-muted">思考の深さ</span>
            <select
              value={config.effort}
              disabled={formDisabled}
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
              disabled={formDisabled}
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
            <span className="mt-1 block text-[11px] text-muted">
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
              disabled={formDisabled}
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
                  disabled={formDisabled}
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
              disabled={formDisabled}
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
        </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          {configLoaded ? "変更は自動で保存され、次回起動時に反映されます" : "設定を読み込んでいます…"}
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
