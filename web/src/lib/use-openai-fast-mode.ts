"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import { isOpenAiFastModeEnabled, OPENAI_FAST_MODE_SETTING_KEY } from "@/lib/openai-fast-mode";

const CHANGE_EVENT = "webui:openai-fast-mode";

/** サーバー設定のFastモードを読み書きし、同じ画面内の複数の表示へ変更を同期する。 */
export function useOpenAiFastMode(active = true) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () =>
      getJson<{ value: string | null }>(`/api/settings/${OPENAI_FAST_MODE_SETTING_KEY}`)
        .then((result) => {
          if (alive) setEnabled(isOpenAiFastModeEnabled(result.value));
        })
        .catch((err) => {
          if (alive) setError(err instanceof Error ? err.message : "Fastモードの読み込みに失敗しました");
        });
    const onChange = (event: Event) => {
      if (alive) setEnabled((event as CustomEvent<boolean>).detail === true);
    };
    void load();
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, [active]);

  const update = useCallback(async (next: boolean) => {
    let previous = false;
    setEnabled((current) => {
      previous = current;
      return next;
    });
    try {
      await sendJson(`/api/settings/${OPENAI_FAST_MODE_SETTING_KEY}`, { value: next ? "1" : "" }, "PUT");
      setError(null);
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "Fastモードの保存に失敗しました");
    }
  }, []);

  return { enabled, error, update };
}
