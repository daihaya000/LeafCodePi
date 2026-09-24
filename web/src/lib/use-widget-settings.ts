"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "@/lib/client";

type Patch<T> = Partial<T> | ((prev: T) => Partial<T>);

const saveChains = new Map<string, Promise<unknown>>();

function persist(key: string, value: object) {
  const path = `/api/settings/${key}`;
  const prev = saveChains.get(key) ?? Promise.resolve();
  // 連続トグルの保存順を保つため key ごとに直列化する。
  const next = prev
    .catch(() => undefined)
    .then(() => sendJson(path, { value: JSON.stringify(value) }, "PUT"))
    .catch(() => undefined);
  saveChains.set(key, next);
}

function removeLegacy(keys: readonly string[]) {
  try {
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/**
 * ウィジェット表示設定をサーバー（/api/settings/[key]）へ保存する。
 * サーバー未保存時だけ旧 localStorage 値を一度移行し、旧キーを削除する。
 */
export function useWidgetSettings<T extends object>(
  key: string,
  normalize: (value: unknown) => T | null,
  readLegacy: () => T | null,
  legacyKeys: readonly string[],
): { settings: T; loaded: boolean; update: (patch: Patch<T>) => void } {
  const [settings, setSettings] = useState<T>({} as T);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<T>({} as T);
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored: T | null = null;
      let fetched = false;
      try {
        const res = await getJson<{ value?: unknown } | undefined>(`/api/settings/${key}`);
        fetched = true;
        if (typeof res?.value === "string") stored = normalize(JSON.parse(res.value));
      } catch {
        /* ignore: 既定値で表示 */
      }
      if (cancelled) return;
      if (!stored) {
        const legacy = readLegacy();
        if (legacy && Object.keys(legacy).length > 0) {
          stored = legacy;
          if (fetched) persist(key, legacy);
        }
      }
      if (fetched) removeLegacy(legacyKeys);
      if (stored && !dirty.current) {
        ref.current = stored;
        setSettings(stored);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // normalize/readLegacy/legacyKeys はモジュール定数前提。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (patch: Patch<T>) => {
      const prev = ref.current;
      const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
      ref.current = next;
      dirty.current = true;
      setSettings(next);
      persist(key, next);
    },
    [key],
  );

  return { settings, loaded, update };
}
