"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_LEAFCODE_MEMORY_SETTINGS,
  MEMORY_SETTING_LIMITS,
  parseLeafCodeMemorySettings,
  type LeafCodeMemorySettings,
  type LeafCodeMemorySettingsSnapshot,
  type MemorySearchEntry,
  type MemorySearchResponse,
} from "@/lib/leafcode-memory-schema";

function SelectField({
  label,
  value,
  hint,
  children,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  children: React.ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text">{label}</span>
      <select
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 rounded-lg border border-border bg-surface-2 px-3 outline-none focus:border-border-strong"
      >
        {children}
      </select>
      {hint && <span className="text-xs leading-5 text-muted">{hint}</span>}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 font-mono outline-none focus:border-border-strong"
        />
        <span className="shrink-0 text-xs text-muted">{unit}</span>
      </span>
      {hint && <span className="text-xs leading-5 text-muted">{hint}</span>}
    </label>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-start gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
      />
      <span>
        <span className="font-medium text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

const categoryLabels: Record<NonNullable<MemorySearchEntry["category"]>, string> = {
  failure: "失敗",
  correction: "訂正",
  insight: "知見",
  preference: "好み",
  convention: "規約",
  "tool-quirk": "ツール特性",
};

function targetLabel(entry: MemorySearchEntry): string {
  if (entry.target === "memory") return entry.project ? "プロジェクト" : "メモリ";
  return entry.target === "user" ? "ユーザー" : "失敗";
}

export function MemorySettings() {
  const [snapshot, setSnapshot] = useState<LeafCodeMemorySettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<LeafCodeMemorySettings>(DEFAULT_LEAFCODE_MEMORY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<MemorySearchEntry[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<LeafCodeMemorySettingsSnapshot>("/api/memory-settings")
      .then((result) => {
        setSnapshot(result);
        setDraft(result.settings);
        setError(result.valid ? null : (result.error ?? "設定値を確認してください"));
        setNotice(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "メモリ設定の読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => reload(), [reload]);

  const dirty = useMemo(
    () => snapshot !== null && JSON.stringify(snapshot.settings) !== JSON.stringify(draft),
    [draft, snapshot],
  );
  const saveNeeded = dirty || snapshot?.valid === false;

  function patch<K extends keyof LeafCodeMemorySettings>(key: K, value: LeafCodeMemorySettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  async function save() {
    const parsed = parseLeafCodeMemorySettings(draft);
    if (parsed.errors.length > 0) {
      setError(parsed.errors[0]);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await sendJson<LeafCodeMemorySettingsSnapshot>("/api/memory-settings", draft, "PUT");
      setSnapshot(result);
      setDraft(result.settings);
      setNotice("保存しました。新しいセッションまたはホスト再起動から反映されます。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "メモリ設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function searchMemory() {
    const query = searchQuery.trim();
    if (!query || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await sendJson<MemorySearchResponse>("/api/memory-search", { query });
      setSearchResults(result.results);
      setHasSearched(true);
    } catch (err) {
      setSearchResults([]);
      setHasSearched(true);
      setSearchError(err instanceof Error ? err.message : "メモリ検索に失敗しました");
    } finally {
      setSearching(false);
    }
  }

  const disabled = loading || saving;
  const seconds = (milliseconds: number) => Math.round(milliseconds / 1_000);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">メモリ</h3>
          <p className="mt-1 text-xs text-muted">
            エージェントが会話から覚えた内容を、次回以降も活用するための設定です。
          </p>
        </div>
        <Badge tone={!snapshot ? "neutral" : !snapshot.valid ? "warning" : dirty ? "warning" : "success"}>
          {!snapshot ? "読み込み中" : !snapshot.valid ? "要確認" : dirty ? "未保存" : "保存済み"}
        </Badge>
      </div>

      <section aria-labelledby="memory-search-heading" className="mt-4 rounded-xl border border-border bg-surface-2 p-3">
        <h3 id="memory-search-heading" className="text-sm font-medium">保存済みメモリを検索</h3>
        <p className="mt-1 text-xs text-muted">エージェントを呼び出さず、保存済みのメモリを確認できます。</p>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void searchMemory();
          }}
        >
          <label htmlFor="memory-search-query" className="sr-only">検索語</label>
          <input
            id="memory-search-query"
            type="search"
            value={searchQuery}
            maxLength={200}
            disabled={searching}
            placeholder="例: デプロイ規約"
            onChange={(event) => setSearchQuery(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-border-strong"
          />
          <Button type="submit" variant="primary" className="h-11" busy={searching} disabled={!searchQuery.trim()}>
            検索
          </Button>
        </form>

        <div aria-live="polite" className="mt-2 min-h-5 text-xs">
          {searchError && <p className="text-danger">{searchError}</p>}
          {!searchError && hasSearched && (
            <p className="text-muted">
              {searchResults.length > 0 ? `${searchResults.length}件見つかりました。` : "一致するメモリはありません。"}
            </p>
          )}
        </div>

        {searchResults.length > 0 && (
          <ul className="mt-2 space-y-2">
            {searchResults.map((entry, index) => (
              <li key={`${entry.target}-${entry.project ?? "global"}-${entry.created}-${index}`} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{targetLabel(entry)}</Badge>
                  <span className="text-[11px] text-muted">{entry.project ?? "グローバル"}</span>
                  {entry.category && <span className="text-[11px] text-muted">{categoryLabels[entry.category]}</span>}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text">{entry.content}</p>
                <p className="mt-2 text-[11px] text-muted">作成 {entry.created} ・ 最終参照 {entry.lastReferenced}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-4 rounded-xl border border-working/25 bg-working-bg px-3 py-2.5 text-xs leading-5 text-text">
        <strong>迷ったら：</strong>初期値のまま「必要時に検索（推奨）」「自動統合」で使い始めてください。保存後は新しいセッションから反映されます。
      </div>

      <fieldset disabled={disabled || snapshot?.writable === false} className="mt-4 space-y-5 disabled:opacity-60">
        <legend className="sr-only">メモリ設定</legend>

        <section aria-labelledby="memory-behavior-heading">
          <h3 id="memory-behavior-heading" className="text-sm font-semibold">使い方</h3>
          <p className="mt-1 mb-3 text-xs text-muted">メモリをいつ検索し、エージェントへどのように伝えるかを決めます。</p>
          <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="メモリの参照方法" hint="会話中に過去のメモリを使うタイミング" value={draft.memoryMode} onChange={(value) => patch("memoryMode", value as LeafCodeMemorySettings["memoryMode"])}>
            <option value="policy-only">必要時に検索（推奨）</option>
            <option value="legacy-inject">毎回プロンプトへ注入</option>
          </SelectField>
          <SelectField label="メモリの指示" value={draft.memoryPolicyStyle} hint="メモリの扱い方をエージェントに伝える詳しさ" onChange={(value) => patch("memoryPolicyStyle", value as LeafCodeMemorySettings["memoryPolicyStyle"])}>
            <option value="full">詳細</option>
            <option value="compact">簡潔</option>
            <option value="custom">カスタム</option>
            <option value="none">注入しない</option>
          </SelectField>
          <SelectField label="会話履歴の検索方式" hint="過去のセッションを検索する方式" value={draft.sessionSearchVariant} onChange={(value) => patch("sessionSearchVariant", value as LeafCodeMemorySettings["sessionSearchVariant"])}>
            <option value="legacy">SQLite / FTS5</option>
            <option value="anchors">アンカー</option>
          </SelectField>
          <SelectField label="容量を超えたとき" hint="保存できる量を超えた場合の処理" value={draft.memoryOverflowStrategy} onChange={(value) => patch("memoryOverflowStrategy", value as LeafCodeMemorySettings["memoryOverflowStrategy"])}>
            <option value="auto-consolidate">自動統合</option>
            <option value="reject">追加を拒否</option>
            <option value="fifo-evict">古い項目から削除</option>
          </SelectField>
          </div>
        </section>

        <section aria-labelledby="memory-capacity-heading">
          <h3 id="memory-capacity-heading" className="text-sm font-semibold">保存容量</h3>
          <p className="mt-1 mb-3 text-xs text-muted">種類ごとに保存できる最大文字数です。</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField label="全体（グローバル）" value={draft.memoryCharLimit} {...MEMORY_SETTING_LIMITS.charLimit} unit="文字" onChange={(value) => patch("memoryCharLimit", value)} />
            <NumberField label="ユーザーごと" value={draft.userCharLimit} {...MEMORY_SETTING_LIMITS.charLimit} unit="文字" onChange={(value) => patch("userCharLimit", value)} />
            <NumberField label="プロジェクトごと" value={draft.projectCharLimit} {...MEMORY_SETTING_LIMITS.charLimit} unit="文字" onChange={(value) => patch("projectCharLimit", value)} />
          </div>
        </section>

        <section aria-labelledby="memory-learning-heading">
          <h3 id="memory-learning-heading" className="text-sm font-semibold">自動学習と常駐指示</h3>
          <p className="mt-1 mb-3 text-xs text-muted">会話からの学習や、毎回読み込むルールを設定します。</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleField label="バックグラウンド学習" checked={draft.reviewEnabled} onChange={(value) => patch("reviewEnabled", value)} />
            <ToggleField label="訂正を自動記録" checked={draft.correctionDetection} onChange={(value) => patch("correctionDetection", value)} />
            <ToggleField label="常駐指示を毎回注入" hint="STANDING.md のユーザー指定ルール" checked={draft.standingInstructionsEnabled} onChange={(value) => patch("standingInstructionsEnabled", value)} />
            <NumberField label="レビュー間隔" value={draft.nudgeInterval} {...MEMORY_SETTING_LIMITS.nudgeInterval} unit="ターン" onChange={(value) => patch("nudgeInterval", value)} />
            <NumberField label="ツール呼出間隔" value={draft.nudgeToolCalls} {...MEMORY_SETTING_LIMITS.nudgeToolCalls} unit="回" onChange={(value) => patch("nudgeToolCalls", value)} />
          </div>
        </section>

        <details className="rounded-xl border border-border bg-surface-2 p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">詳細設定</summary>
          <div className="mt-3 space-y-4 border-t border-border pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="レビュー実行方式" value={draft.reviewTransport} onChange={(value) => patch("reviewTransport", value as LeafCodeMemorySettings["reviewTransport"])}>
                <option value="direct">プロセス内（推奨）</option>
                <option value="subprocess">サブプロセス</option>
              </SelectField>
              <NumberField label="レビュー対象" value={draft.reviewRecentMessages} {...MEMORY_SETTING_LIMITS.recentMessages} unit="件" hint="0 は全件" onChange={(value) => patch("reviewRecentMessages", value)} />
              <NumberField label="自動統合の猶予" value={seconds(draft.overflowGraceMs)} min={0} max={3_600} unit="秒" onChange={(value) => patch("overflowGraceMs", value * 1_000)} />
              <NumberField label="統合タイムアウト" value={seconds(draft.consolidationTimeoutMs)} min={10} max={3_600} unit="秒" onChange={(value) => patch("consolidationTimeoutMs", value * 1_000)} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleField label="統合失敗を通知" checked={draft.autoConsolidationWarnOnFailure} onChange={(value) => patch("autoConsolidationWarnOnFailure", value)} />
              <ToggleField label="圧縮前に保存" checked={draft.flushOnCompact} onChange={(value) => patch("flushOnCompact", value)} />
              <ToggleField label="終了時に保存" checked={draft.flushOnShutdown} onChange={(value) => patch("flushOnShutdown", value)} />
              <ToggleField label="失敗メモリをプロンプトへ注入" checked={draft.failureInjectionEnabled} onChange={(value) => patch("failureInjectionEnabled", value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <NumberField label="保存を始める最小ターン" value={draft.flushMinTurns} {...MEMORY_SETTING_LIMITS.flushMinTurns} unit="ターン" onChange={(value) => patch("flushMinTurns", value)} />
              <NumberField label="保存対象" value={draft.flushRecentMessages} {...MEMORY_SETTING_LIMITS.recentMessages} unit="件" hint="0 は全件" onChange={(value) => patch("flushRecentMessages", value)} />
              <NumberField label="失敗メモリ最大日数" value={draft.failureInjectionMaxAgeDays} {...MEMORY_SETTING_LIMITS.failureInjectionMaxAgeDays} unit="日" onChange={(value) => patch("failureInjectionMaxAgeDays", value)} />
              <NumberField label="失敗メモリ最大件数" value={draft.failureInjectionMaxEntries} {...MEMORY_SETTING_LIMITS.failureInjectionMaxEntries} unit="件" onChange={(value) => patch("failureInjectionMaxEntries", value)} />
            </div>
          </div>
        </details>
      </fieldset>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" busy={saving} disabled={disabled || !saveNeeded || snapshot?.writable === false} onClick={() => void save()}>
          保存
        </Button>
        <Button variant="secondary" size="sm" disabled={disabled || snapshot?.writable === false} onClick={() => { setDraft({ ...DEFAULT_LEAFCODE_MEMORY_SETTINGS }); setNotice(null); }}>
          既定値に戻す
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={reload}>再読込</Button>
      </div>

      {snapshot?.path && <p className="mt-3 break-all font-mono text-[11px] text-muted">{snapshot.path}{snapshot.exists ? "" : "（未作成・保存時に作成）"}</p>}
      <div aria-live="polite" className="mt-2 min-h-5 text-sm">
        {notice && <p role="status" className="text-success">{notice}</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </div>
  );
}
