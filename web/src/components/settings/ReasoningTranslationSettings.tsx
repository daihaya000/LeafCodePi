"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import {
  readReasoningTranslationMode,
  writeReasoningTranslationMode,
  type ReasoningTranslationMode,
} from "@/lib/reasoning-translation";

const options: { value: ReasoningTranslationMode; label: string; description: string }[] = [
  { value: "translated", label: "日本語", description: "ローカル翻訳を優先して表示" },
  { value: "bilingual", label: "日本語＋原文", description: "日本語の下に英語原文も表示" },
  { value: "original", label: "原文", description: "翻訳せず英語のまま表示" },
];

type TranslationStatus = {
  state?: string;
  installed?: boolean;
  installState?: string;
  installError?: string | null;
  cacheEntries?: number;
};

export function formatTranslationServiceState(body: TranslationStatus | null): string {
  if (body?.state === "ready") return "準備完了";
  if (body?.state === "error") return "エラー";
  if (body?.installed === true) return "導入済み（未起動）";
  if (body?.state === "host-outdated") return "ホスト再起動が必要";
  if (body?.state === "unavailable") return "ホスト未接続";
  return "未導入";
}

export function ReasoningTranslationSettings() {
  const [mode, setMode] = useState<ReasoningTranslationMode>(readReasoningTranslationMode);
  const [serviceState, setServiceState] = useState("確認中");
  const [cacheEntries, setCacheEntries] = useState<number>(0);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installStarted, setInstallStarted] = useState(false);

  useEffect(() => {
    const update = () => setMode(readReasoningTranslationMode());
    window.addEventListener("webui:reasoning-translation-mode", update);
    return () => window.removeEventListener("webui:reasoning-translation-mode", update);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/translation/status", { cache: "no-store" })
      .then(async (response) => (await response.json().catch(() => null)) as TranslationStatus | null)
      .then((body: TranslationStatus | null) => {
        if (!active) return;
        setServiceState(formatTranslationServiceState(body));
        setCacheEntries(typeof body?.cacheEntries === "number" ? body.cacheEntries : 0);
        setInstalling(body?.installState === "running");
        setInstallError(
          body?.installState === "error" && typeof body.installError === "string"
            ? body.installError
            : null,
        );
      })
      .catch(() => active && setServiceState("ホスト未接続"));
    return () => {
      active = false;
    };
  }, []);

  // 導入中は完了／失敗が status に反映されるまでポーリングする。
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => {
      void fetch("/api/translation/status", { cache: "no-store" })
        .then(async (response) =>
          (await response.json().catch(() => null)) as TranslationStatus | null,
        )
        .then((body) => {
          if (body?.installState === "running") return;
          setInstalling(false);
          setServiceState(formatTranslationServiceState(body));
          setInstallError(
            body?.installState === "error" && typeof body.installError === "string"
              ? body.installError
              : null,
          );
        })
        .catch(() => {});
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [installing]);

  const startInstall = async () => {
    if (installing || installStarted) return;
    setInstallStarted(true);
    setInstallError(null);
    try {
      const response = await fetch("/api/translation/install", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          typeof body.error === "string" ? body.error : "導入を開始できませんでした",
        );
      }
      setInstalling(true);
    } catch (error) {
      setInstallStarted(false);
      setInstallError(
        error instanceof Error ? error.message : "導入を開始できませんでした",
      );
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">思考要約の翻訳</h2>
      <p className="mt-1 text-xs text-faint">
        英語の思考要約を、このPC上のローカル翻訳エンジンで日本語表示します。外部サービスへは送信しません。
        思考欄の編集ボタンで保存した修正訳は、すべてのセッションで再利用されます。
      </p>
      <p className="mt-2 text-xs text-faint">
        サービス状態: {serviceState}
        {cacheEntries > 0 ? `（キャッシュ ${cacheEntries}件）` : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            onClick={() => {
              setMode(option.value);
              writeReasoningTranslationMode(option.value);
            }}
            className={mode === option.value
              ? "rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-sm text-accent"
              : "rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface-2"}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-faint">
        {options.find((option) => option.value === mode)?.description}
      </p>
      {installing && (
        <p role="status" className="mt-2 text-xs text-muted">
          ローカル翻訳エンジンを導入中です…（モデルのダウンロードを含むため数分かかります）
        </p>
      )}
      {installError && (
        <p role="alert" className="mt-2 break-all text-[11px] text-danger">
          導入に失敗しました: {installError}
        </p>
      )}
      {serviceState === "未導入" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            busy={installing}
            disabled={installing || installStarted}
            onClick={() => void startInstall()}
            aria-label="ローカル翻訳を導入"
          >
            ローカル翻訳を導入
          </Button>
          <span className="text-[11px] text-faint">
            初回のみ。Argos 翻訳モデル（約90MB）をダウンロードします。
          </span>
        </div>
      )}
    </div>
  );
}
