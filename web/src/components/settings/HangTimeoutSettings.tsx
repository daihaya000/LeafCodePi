"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_AUTO_RESUME_MODE,
  DEFAULT_HANG_TIMEOUT_MS,
  MAX_HANG_TIMEOUT_MS,
  MIN_HANG_TIMEOUT_MS,
  isAutoResumeMode,
  readAutoResumeMode,
  readHangTimeoutMs,
  type AutoResumeMode,
  writeAutoResumeMode,
  writeHangTimeoutMs,
} from "@/lib/hang-timeout";

type HangSettingsDto = {
  timeoutMs: number;
  resumeMode?: AutoResumeMode;
};

export function HangTimeoutSettings() {
  // SSRとの一致を保つため初期値はデフォルト固定とし、mount後にlocalStorageの保存値へ切り替える。
  const [minutes, setMinutes] = useState(() => String(DEFAULT_HANG_TIMEOUT_MS / 60_000));
  const [resumeMode, setResumeMode] = useState<AutoResumeMode>(DEFAULT_AUTO_RESUME_MODE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMinutes(String(readHangTimeoutMs() / 60_000));
    setResumeMode(readAutoResumeMode());
  }, []);

  function applySettings(result: HangSettingsDto): void {
    const mode = result.resumeMode ?? DEFAULT_AUTO_RESUME_MODE;
    writeHangTimeoutMs(result.timeoutMs);
    writeAutoResumeMode(mode);
    setMinutes(String(result.timeoutMs / 60_000));
    setResumeMode(mode);
  }

  const reload = useCallback(() => {
    void getJson<HangSettingsDto>("/api/settings/hang-timeout")
      .then((result) => {
        applySettings(result);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "ハング判定時間の読み込みに失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function commitTimeout() {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed)) {
      setError("数値を入力してください");
      return;
    }
    const timeoutMs = Math.min(
      MAX_HANG_TIMEOUT_MS,
      Math.max(MIN_HANG_TIMEOUT_MS, Math.round(parsed * 60_000)),
    );
    try {
      const result = await sendJson<HangSettingsDto>(
        "/api/settings/hang-timeout",
        { timeoutMs },
        "PATCH",
      );
      applySettings(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ハング判定時間の保存に失敗しました");
    }
  }

  async function commitResumeMode(next: AutoResumeMode) {
    const previous = resumeMode;
    setResumeMode(next);
    try {
      const result = await sendJson<HangSettingsDto>(
        "/api/settings/hang-timeout",
        { resumeMode: next },
        "PATCH",
      );
      applySettings(result);
      setError(null);
    } catch (err) {
      setResumeMode(previous);
      setError(err instanceof Error ? err.message : "自動再開方法の保存に失敗しました");
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">ハング判定</h2>
      <p className="mt-1 text-xs text-muted">
        応答がない状態がこの時間続いた場合、自動停止して設定した方法で再開します（Goal Loop は対象外）。
      </p>
      <label className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-sm text-muted">ハング判定時間</span>
        <input
          type="number"
          min={MIN_HANG_TIMEOUT_MS / 60_000}
          max={MAX_HANG_TIMEOUT_MS / 60_000}
          step={0.5}
          value={minutes}
          aria-label="ハング判定時間"
          onChange={(event) => setMinutes(event.target.value)}
          onBlur={() => void commitTimeout()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-9 w-full max-w-[10rem] rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm outline-none focus:border-border-strong"
        />
        <span className="text-xs text-muted">分</span>
      </label>
      <label className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-sm text-muted">自動再開方法</span>
        <select
          value={resumeMode}
          aria-label="自動再開方法"
          aria-describedby="hang-resume-help"
          onChange={(event) => {
            if (isAutoResumeMode(event.target.value)) void commitResumeMode(event.target.value);
          }}
          className="h-9 w-full max-w-[16rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
        >
          <option value="same">同じプロンプトを再送</option>
          <option value="continue">「続けて」を送信</option>
        </select>
      </label>
      <p id="hang-resume-help" className="mt-2 text-[11px] text-muted">
        無言終了時は選択した方法で自動再開します。手動の「再開」ボタンは同じプロンプトを再送します。
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
