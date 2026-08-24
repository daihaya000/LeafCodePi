"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  MAX_HANG_TIMEOUT_MS,
  MIN_HANG_TIMEOUT_MS,
  readHangTimeoutMs,
  writeHangTimeoutMs,
} from "@/lib/hang-timeout";

export function HangTimeoutSettings() {
  const [minutes, setMinutes] = useState(() => String(readHangTimeoutMs() / 60_000));
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void getJson<{ timeoutMs: number }>("/api/settings/hang-timeout")
      .then((result) => {
        writeHangTimeoutMs(result.timeoutMs);
        setMinutes(String(result.timeoutMs / 60_000));
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "ハング判定時間の読み込みに失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function commit() {
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
      const result = await sendJson<{ timeoutMs: number }>(
        "/api/settings/hang-timeout",
        { timeoutMs },
        "PATCH",
      );
      writeHangTimeoutMs(result.timeoutMs);
      setMinutes(String(result.timeoutMs / 60_000));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ハング判定時間の保存に失敗しました");
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">ハング判定</h2>
      <p className="mt-1 text-xs text-muted">
        応答がない状態がこの時間続いた場合、自動停止して同じプロンプトを再送します（Goal Loop は対象外）。
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
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-9 w-full max-w-[10rem] rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm outline-none focus:border-border-strong"
        />
        <span className="text-xs text-muted">分</span>
      </label>
      <p className="mt-2 text-[11px] text-muted">
        無言終了したターンは自動的に再開します。失敗時は「再開」ボタンから再送できます。
      </p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
