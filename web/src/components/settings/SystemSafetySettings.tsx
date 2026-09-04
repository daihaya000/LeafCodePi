"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  SYSTEM_SAFETY_LEVEL_OPTIONS,
  isSystemSafetyLevel,
  type SystemSafetyLevel,
} from "@/lib/system-safety";

type SystemSafetyDto = {
  level?: SystemSafetyLevel;
  systemSafety?: boolean;
};

function levelFromDto(config: SystemSafetyDto): SystemSafetyLevel {
  if (isSystemSafetyLevel(config.level)) return config.level;
  return config.systemSafety === false ? "off" : "strict";
}

export function SystemSafetySettings() {
  const [level, setLevel] = useState<SystemSafetyLevel>("strict");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void getJson<SystemSafetyDto>("/api/settings/system-safety")
      .then((config) => {
        setLevel(levelFromDto(config));
        setLoaded(true);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "システム安全ガード設定の取得に失敗しました");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const commit = async (next: SystemSafetyLevel) => {
    if (!isSystemSafetyLevel(next) || next === level) return;
    setBusy(true);
    setError(null);
    const previous = level;
    setLevel(next);
    try {
      const result = await sendJson<SystemSafetyDto>(
        "/api/settings/system-safety",
        { level: next },
        "PATCH",
      );
      setLevel(levelFromDto(result));
    } catch (err) {
      setLevel(previous);
      setError(err instanceof Error ? err.message : "システム安全ガード設定の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const selected = SYSTEM_SAFETY_LEVEL_OPTIONS.find((option) => option.value === level);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">システム安全ガード</h2>
      <p className="mt-1 text-xs text-muted">
        OS・サービス・ディスクなどへの危険な変更をどの程度止めるかを選びます。どの度合いでも
        `.env` / `.ssh` などの保護パスと LeafCodePi 自身の停止禁止は続きます。
      </p>
      <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-4">
        <label htmlFor="system-safety-level" className="text-sm text-muted sm:w-48 sm:shrink-0">
          度合い
        </label>
        <select
          id="system-safety-level"
          aria-label="システム安全ガードの度合い"
          className="h-12 min-w-0 w-full rounded-xl border border-border bg-surface px-4 text-base sm:h-14 sm:max-w-sm sm:px-5 sm:text-lg"
          value={level}
          disabled={busy || !loaded}
          onChange={(event) => void commit(event.target.value as SystemSafetyLevel)}
        >
          {SYSTEM_SAFETY_LEVEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
          再読込
        </Button>
      </div>
      {selected && <p className="mt-3 text-xs text-muted">{selected.description}</p>}
      {level === "off" && (
        <p className="mt-2 text-xs text-warning">
          無効中は OS 変更系コマンドの調査・承認フローが動きません。必要なときだけ切ってください。
        </p>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
