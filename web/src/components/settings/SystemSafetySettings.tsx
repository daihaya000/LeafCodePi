"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_SYSTEM_SAFETY_LEVEL,
  SYSTEM_SAFETY_LEVEL_OPTIONS,
  SYSTEM_SAFETY_LEVELS,
  isSystemSafetyLevel,
  systemSafetyLevelFromIndex,
  systemSafetyLevelIndex,
  type SystemSafetyLevel,
} from "@/lib/system-safety";

type SystemSafetyDto = {
  level?: SystemSafetyLevel;
  systemSafety?: boolean;
};

function levelFromDto(config: SystemSafetyDto): SystemSafetyLevel {
  if (isSystemSafetyLevel(config.level)) return config.level;
  return config.systemSafety === false ? "off" : DEFAULT_SYSTEM_SAFETY_LEVEL;
}

export function SystemSafetySettings() {
  const [level, setLevel] = useState<SystemSafetyLevel>(DEFAULT_SYSTEM_SAFETY_LEVEL);
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
  const index = systemSafetyLevelIndex(level);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">システム安全ガード</h3>
      <p className="mt-1 text-xs text-muted">
        OS・サービス・ディスクなどへの危険な変更をどの程度止めるかを選びます。どの度合いでも
        `.env` / `.ssh` などの保護パスと LeafCodePi 自身の停止禁止は続きます。既定は標準です。
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="system-safety-level" className="text-sm text-muted">
            度合い
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text" aria-live="polite">
              {selected?.label ?? level}
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => reload()}>
              再読込
            </Button>
          </div>
        </div>
        <input
          id="system-safety-level"
          type="range"
          min={0}
          max={SYSTEM_SAFETY_LEVELS.length - 1}
          step={1}
          value={index}
          disabled={busy || !loaded}
          aria-label="システム安全ガードの度合い"
          aria-valuetext={selected?.label ?? level}
          list="system-safety-level-marks"
          onChange={(event) => void commit(systemSafetyLevelFromIndex(Number(event.target.value)))}
          className="w-full accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40"
        />
        <datalist id="system-safety-level-marks">
          {SYSTEM_SAFETY_LEVELS.map((value, markIndex) => (
            <option key={value} value={markIndex} label={SYSTEM_SAFETY_LEVEL_OPTIONS[markIndex]?.label} />
          ))}
        </datalist>
        <div className="flex justify-between gap-2 text-[11px] text-muted" aria-hidden="true">
          {SYSTEM_SAFETY_LEVEL_OPTIONS.map((option) => (
            <span key={option.value} className="min-w-0 flex-1 text-center first:text-left last:text-right">
              {option.label}
            </span>
          ))}
        </div>
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
