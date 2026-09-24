"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "@/lib/client";

type Patch<T> = Partial<T> | ((prev: T) => Partial<T>);

const saveChains = new Map<string, Promise<unknown>>();
/** 取得・更新済みの値。再マウント時に保存中の PUT より古い GET 結果で戻らないようにする。 */
const cache = new Map<string, object>();

function persist(key: string, value: object): Promise<boolean> {
  const path = `/api/settings/${key}`;
  const prev = saveChains.get(key) ?? Promise.resolve();
  // 連続トグルの保存順を保つため key ごとに直列化する。
  const next = prev
    .catch(() => undefined)
    .then(() => sendJson(path, { value: JSON.stringify(value) }, "PUT"))
    .then(
      () => true,
      () => false,
    );
  saveChains.set(key, next);
  return next;
}

function removeLegacy(keys: readonly string[]) {
  try {
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** テスト用。 */
export function resetWidgetSettingsCache() {
  cache.clear();
  saveChains.clear();
}

/**
 * ウィジェット表示設定をサーバー（/api/settings/[key]）へ保存する。
 * サーバー未保存時だけ旧 localStorage 値を一度移行し、保存成功後に旧キーを削除する。
 * `loaded` はサーバー値の取得に成功した場合だけ true。
 */
export function useWidgetSettings<T extends object>(
  key: string,
  normalize: (value: unknown) => T | null,
  readLegacy: () => T | null,
  legacyKeys: readonly string[],
): { settings: T; loaded: boolean; update: (patch: Patch<T>) => void } {
  const cached = cache.get(key) as T | undefined;
  const [settings, setSettings] = useState<T>(cached ?? ({} as T));
  const [loaded, setLoaded] = useState(cached !== undefined);
  const ref = useRef<T>(cached ?? ({} as T));
  /** 読み込み完了前にユーザーが変更したフィールド。 */
  const pending = useRef<Partial<T> | null>(null);

  useEffect(() => {
    if (cache.has(key)) return;
    let cancelled = false;
    void (async () => {
      let stored: T | null = null;
      try {
        const res = await getJson<{ value?: unknown } | undefined>(`/api/settings/${key}`);
        if (typeof res?.value === "string") {
          try {
            stored = normalize(JSON.parse(res.value));
          } catch {
            stored = null;
          }
        }
      } catch {
        // 取得失敗時は既定値で表示し、サーバー値を上書きしない（読み込み前の変更も保存しない）。
        return;
      }
      if (cancelled) return;
      let base = stored;
      if (!base) {
        const legacy = readLegacy();
        if (legacy && Object.keys(legacy).length > 0) {
          base = legacy;
          if (!pending.current) {
            void persist(key, legacy).then((ok) => {
              if (ok) removeLegacy(legacyKeys);
            });
          }
        } else {
          removeLegacy(legacyKeys);
        }
      } else {
        removeLegacy(legacyKeys);
      }
      const merged = { ...(base ?? {}), ...(pending.current ?? {}) } as T;
      if (pending.current) {
        // 読み込み前の変更をサーバー値へ統合して保存する。
        void persist(key, merged).then((ok) => {
          if (ok) removeLegacy(legacyKeys);
        });
        pending.current = null;
      }
      ref.current = merged;
      cache.set(key, merged);
      setSettings(merged);
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
      const delta = typeof patch === "function" ? patch(prev) : patch;
      const next = { ...prev, ...delta };
      ref.current = next;
      setSettings(next);
      if (cache.has(key)) {
        cache.set(key, next);
        void persist(key, next);
      } else {
        // 未読み込み: 部分値でサーバーを上書きせず、読み込み後に統合して保存する。
        pending.current = { ...(pending.current ?? {}), ...delta };
      }
    },
    [key],
  );

  return { settings, loaded, update };
}
