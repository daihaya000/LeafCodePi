"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { PROJECT_ICON_TONES } from "@/components/ProjectIcon";
import { PROJECT_ICON_COLORS, type ProjectIconColor } from "@/lib/types";
import {
  DEFAULT_SESSION_LABELS,
  hydrateSessionLabelsFromServer,
  MAX_SESSION_LABEL_HINT_CHARS,
  MAX_SESSION_LABEL_NAME_CHARS,
  MAX_SESSION_LABELS,
  normalizeSessionLabels,
  readSessionLabels,
  resolveSessionLabels,
  subscribeSessionLabels,
  writeSessionLabels,
  writeSessionLabelsToServer,
  type SessionLabel,
} from "@/lib/session-label-settings";

export function SessionLabelSettings() {
  // SSRとの一致を保つため初期値は既定値固定とし、mount後に保存値へ切り替える。
  const [labels, setLabels] = useState<SessionLabel[]>([...DEFAULT_SESSION_LABELS]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLabels(readSessionLabels());
    void hydrateSessionLabelsFromServer().then(() => {
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
        タイトル生成時に Jev が会話を分類して付けるラベルです。判定ヒントは分類の判断基準に使われます。空にするとラベルを付けません。
      </p>
      <ul className="mt-3 space-y-2">
        {labels.map((label, index) => (
          <li key={label.id} className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-[4rem_10rem_minmax(0,1fr)_9rem_auto]">
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
