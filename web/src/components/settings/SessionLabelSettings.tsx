"use client";

import { useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui";
import { getJson } from "@/lib/client";
import { AUTO_JEV_ENABLED_SETTING_KEY, isAutoJevEnabled } from "@/lib/auto-jev-settings";
import { readAutoJevEnabled, subscribeAutoSetting } from "@/lib/auto-settings";
import {
  hasUsableJevModel,
  JEV_MODEL_CHANGED_EVENT,
  type JevModelSettingsDto,
} from "@/lib/jev-model-settings";
import { PROJECT_ICON_TONES } from "@/components/ProjectIcon";
import { PROJECT_ICON_COLORS, type ProjectIconColor } from "@/lib/types";
import {
  DEFAULT_SESSION_LABELS,
  hydrateSessionLabelsFromServer,
  MAX_SESSION_LABEL_HINT_CHARS,
  MAX_SESSION_LABEL_NAME_CHARS,
  MAX_SESSION_LABELS,
  normalizeSessionLabels,
  readSessionLabelJevEnabledFromServer,
  readSessionLabels,
  resolveSessionLabels,
  subscribeSessionLabels,
  writeSessionLabelJevEnabled,
  writeSessionLabels,
  writeSessionLabelsToServer,
  type SessionLabel,
} from "@/lib/session-label-settings";

export function SessionLabelSettings() {
  // SSRとの一致を保つため初期値は既定値固定とし、mount後に保存値へ切り替える。
  const [labels, setLabels] = useState<SessionLabel[]>([...DEFAULT_SESSION_LABELS]);
  const [error, setError] = useState<string | null>(null);
  // null = not loaded yet. The toggle is operable only when every value is known.
  const [jevEnabled, setJevEnabled] = useState<boolean | null>(null);
  const [jevModelUsable, setJevModelUsable] = useState<boolean | null>(null);
  const [jevGlobalEnabled, setJevGlobalEnabled] = useState<boolean | null>(null);
  const [jevSaving, setJevSaving] = useState(false);
  const [jevError, setJevError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let request = 0;
    const loadModels = () => {
      const current = ++request;
      void getJson<JevModelSettingsDto>("/api/jev-model", undefined, { coalesce: false })
        .then((dto) => Boolean(dto?.settings) && hasUsableJevModel(dto))
        .catch(() => false)
        .then((usable) => { if (active && current === request) setJevModelUsable(usable); });
    };
    loadModels();
    window.addEventListener(JEV_MODEL_CHANGED_EVENT, loadModels);
    void readSessionLabelJevEnabledFromServer().then(
      (enabled) => { if (active) setJevEnabled(enabled); },
      () => { if (active) setJevError("Jev分類の設定を取得できません"); },
    );
    void getJson<{ value: string | null }>(`/api/settings/${AUTO_JEV_ENABLED_SETTING_KEY}`)
      .then((data) => isAutoJevEnabled(data?.value), () => readAutoJevEnabled())
      .then((enabled) => { if (active) setJevGlobalEnabled(enabled); });
    const unsubscribeGlobal = subscribeAutoSetting(AUTO_JEV_ENABLED_SETTING_KEY, () => setJevGlobalEnabled(readAutoJevEnabled()));
    return () => {
      active = false;
      window.removeEventListener(JEV_MODEL_CHANGED_EVENT, loadModels);
      unsubscribeGlobal();
    };
  }, []);

  const jevBlockedReason = jevModelUsable === false
    ? "Jevモデルが登録されていないため無効です。"
    : jevGlobalEnabled === false
      ? "Jev判定が全体で無効のため無効です。"
      : null;
  const jevReady = jevEnabled !== null && jevModelUsable === true && jevGlobalEnabled === true;
  const jevChecked = jevReady && jevEnabled === true;

  async function toggleJev() {
    if (!jevReady || jevSaving) return;
    const next = !jevEnabled;
    setJevSaving(true);
    setJevError(null);
    try {
      await writeSessionLabelJevEnabled(next);
      setJevEnabled(next);
    } catch {
      setJevError("Jev分類の設定を保存できません");
    } finally {
      setJevSaving(false);
    }
  }

  useEffect(() => {
    let active = true;
    setLabels(readSessionLabels());
    void hydrateSessionLabelsFromServer({ fresh: true }).then(() => {
      if (active) setLabels(readSessionLabels());
    });
    const unsubscribe = subscribeSessionLabels(() => setLabels(readSessionLabels()));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  function commit(next: SessionLabel[]) {
    const normalized = normalizeSessionLabels(next);
    if (next.length > 0 && normalized.length < next.length) {
      setError("名前は必須・20文字以内で、他のラベルと重複しない必要があります");
    } else {
      setError(null);
    }
    setLabels(next);
    writeSessionLabels(normalized);
    void writeSessionLabelsToServer(normalized);
  }

  function update(index: number, patch: Partial<SessionLabel>) {
    commit(labels.map((label, i) => (i === index ? { ...label, ...patch } : label)));
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">セッションラベル</h3>
      <p className="mt-1 text-xs text-muted">
        初回応答完了後またはタイトル手動生成時に会話を分類して付けるラベルです。判定ヒントは分類の判断基準に使われます。空にするとラベルを付けません。
      </p>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-bg px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm">Jevで分類</p>
          <p className="text-[11px] text-muted">
            {jevBlockedReason
              ? `${jevBlockedReason}タイトル生成モデルがタイトルと同時に分類します。`
              : "OFFにするとタイトル生成モデルがタイトルと同時に分類します（追加リクエストなし）。"}
          </p>
        </div>
        <Switch
          checked={jevChecked}
          disabled={!jevReady}
          busy={jevSaving}
          label={`セッションラベルのJev分類を${jevChecked ? "無効化" : "有効化"}`}
          onChange={() => void toggleJev()}
        />
      </div>
      {jevError && <p role="alert" className="mt-2 text-sm text-danger">{jevError}</p>}
      <ul className="mt-3 space-y-2">
        {labels.map((label, index) => (
          <li key={label.id} className="grid min-w-0 grid-cols-1 items-center gap-2 @xl:grid-cols-[4rem_10rem_minmax(0,1fr)_9rem_auto]">
            <span
              className={`w-16 truncate rounded border px-1 text-center text-[10px] leading-4 ${PROJECT_ICON_TONES[label.color]}`}
            >
              {label.name || "—"}
            </span>
            <input
              value={label.name}
              maxLength={MAX_SESSION_LABEL_NAME_CHARS}
              aria-label={`ラベル${index + 1}の名前`}
              placeholder="名前"
              onChange={(event) => update(index, { name: event.target.value })}
              className="h-9 w-full min-w-0 rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
            />
            <input
              value={label.hint}
              maxLength={MAX_SESSION_LABEL_HINT_CHARS}
              aria-label={`ラベル${index + 1}の判定ヒント`}
              placeholder="判定ヒント（どんな会話か）"
              onChange={(event) => update(index, { hint: event.target.value })}
              className="h-9 w-full min-w-0 rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
            />
            <select
              value={label.color}
              aria-label={`ラベル${index + 1}の色`}
              onChange={(event) => update(index, { color: event.target.value as ProjectIconColor })}
              className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm text-text outline-none focus:border-border-strong"
            >
              {PROJECT_ICON_COLORS.map((color) => (
                <option key={color} value={color}>{color}</option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`ラベル${index + 1}を削除`}
              onClick={() => commit(labels.filter((_, i) => i !== index))}
            >
              削除
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={labels.length >= MAX_SESSION_LABELS}
          onClick={() =>
            commit([
              ...labels,
              { id: crypto.randomUUID(), name: "", hint: "", color: "blue" as ProjectIconColor },
            ])
          }
        >
          ラベルを追加
        </Button>
        <Button variant="ghost" size="sm" onClick={() => commit(resolveSessionLabels(null))}>
          既定に戻す
        </Button>
        <span className="text-[11px] text-muted">最大{MAX_SESSION_LABELS}件</span>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
