"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  COLLABORATION_CHECK_IDS,
  COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_CONFIG,
  formatCheckArgs,
  parseCheckArgs,
  type CollaborationCheckId,
  type CollaborationConfig,
  type CollaborationConfigSnapshot,
  type CollaborationMode,
} from "@/lib/collaboration-schema";

const CHECK_LABELS: Record<CollaborationCheckId, string> = {
  typecheck: "型検査",
  test: "テスト",
  lint: "Lint",
  build: "ビルド",
};

type Draft = {
  mode: CollaborationMode;
  heartbeatSec: string;
  leaseTtlSec: string;
  stuckAfterSec: string;
  askTimeoutSec: string;
  activityLimit: string;
  checks: Record<CollaborationCheckId, { file: string; args: string }>;
};

function msToSecInput(ms: number): string {
  const seconds = ms / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}

function configToDraft(config: CollaborationConfig): Draft {
  return {
    mode: config.mode,
    heartbeatSec: msToSecInput(config.heartbeatMs),
    leaseTtlSec: msToSecInput(config.leaseTtlMs),
    stuckAfterSec: msToSecInput(config.stuckAfterMs),
    askTimeoutSec: msToSecInput(config.askTimeoutMs),
    activityLimit: String(config.activityLimit),
    checks: Object.fromEntries(
      COLLABORATION_CHECK_IDS.map((id) => [
        id,
        { file: config.checks[id].file, args: formatCheckArgs(config.checks[id].args) },
      ]),
    ) as Draft["checks"],
  };
}

function parsePositiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function draftToConfig(draft: Draft): { config?: CollaborationConfig; error?: string } {
  const heartbeatSec = parsePositiveNumber(draft.heartbeatSec);
  const leaseTtlSec = parsePositiveNumber(draft.leaseTtlSec);
  const stuckAfterSec = parsePositiveNumber(draft.stuckAfterSec);
  const askTimeoutSec = parsePositiveNumber(draft.askTimeoutSec);
  const activityLimit = parsePositiveNumber(draft.activityLimit);
  if (
    heartbeatSec === undefined ||
    leaseTtlSec === undefined ||
    stuckAfterSec === undefined ||
    askTimeoutSec === undefined ||
    activityLimit === undefined
  ) {
    return { error: "数値を入力してください" };
  }
  const checks = {} as CollaborationConfig["checks"];
  for (const id of COLLABORATION_CHECK_IDS) {
    const file = draft.checks[id].file.trim();
    if (!file) return { error: `${CHECK_LABELS[id]} のコマンドを入力してください` };
    const args = parseCheckArgs(draft.checks[id].args);
    if (!args) return { error: `${CHECK_LABELS[id]} の引数を解析できません` };
    checks[id] = { file, args };
  }
  return {
    config: {
      mode: draft.mode,
      heartbeatMs: Math.round(heartbeatSec * 1_000),
      leaseTtlMs: Math.round(leaseTtlSec * 1_000),
      stuckAfterMs: Math.round(stuckAfterSec * 1_000),
      askTimeoutMs: Math.round(askTimeoutSec * 1_000),
      activityLimit: Math.round(activityLimit),
      checks,
    },
  };
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-full max-w-[10rem] rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm outline-none focus:border-border-strong"
        />
        <span className="text-xs text-muted">{unit}</span>
      </span>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export function CollaborationSettings() {
  const [draft, setDraft] = useState<Draft>(() => configToDraft(DEFAULT_COLLABORATION_CONFIG));
  const [snapshot, setSnapshot] = useState<CollaborationConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<CollaborationConfigSnapshot>("/api/collaboration/config")
      .then((result) => {
        setSnapshot(result);
        setDraft(configToDraft(result.config));
        setError(result.valid ? null : (result.error ?? "協調設定ファイルが不正なため、既定値を表示しています"));
        setNotice(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "協調設定の読み込みに失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const savedDraft = useMemo(
    () => (snapshot ? configToDraft(snapshot.config) : null),
    [snapshot],
  );
  const dirty = savedDraft !== null && JSON.stringify(savedDraft) !== JSON.stringify(draft);

  async function save(next: Draft) {
    const parsed = draftToConfig(next);
    if (!parsed.config) {
      setError(parsed.error ?? "入力内容を確認してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await sendJson<CollaborationConfigSnapshot>(
        "/api/collaboration/config",
        parsed.config,
        "PUT",
      );
      setSnapshot(result);
      setDraft(configToDraft(result.config));
      setNotice("保存しました。実行中のセッションには、新しいセッションまたはホスト再起動から適用されます。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "協調設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">協調</h2>
        <Badge tone={!snapshot || !snapshot.valid ? "warning" : draft.mode === "strict" ? "success" : "warning"}>
          {!snapshot ? "読み込み中" : !snapshot.valid ? "設定不正" : draft.mode === "strict" ? "厳格" : "緩和"}
        </Badge>
      </div>
      <p className="text-xs text-muted">
        同じリポジトリを複数セッションで開いたときのリース、commit gate、peer 通信の設定です。
        エージェントツールからは書き換えられません。
      </p>

      <fieldset className="mt-4 space-y-2" disabled={loading}>
        <legend className="text-sm text-muted">モード</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["strict", "厳格", "標準の write / edit / bash を隠し、leafcode_* だけを許可します。"],
              ["permissive", "緩和", "開発用。事故ゼロは主張しません。"],
            ] as const
          ).map(([value, label, description]) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name="collaboration-mode"
                value={value}
                checked={draft.mode === value}
                onChange={() => setDraft((current) => ({ ...current, mode: value }))}
                className="mt-1 accent-accent"
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="mt-0.5 block text-[11px] text-faint">{description}</span>
              </span>
            </label>
          ))}
        </div>
        {draft.mode === "permissive" && (
          <p className="text-xs text-warning">
            緩和モードでは標準ツールが残るため、並列編集の事故を防げません。
          </p>
        )}
      </fieldset>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <NumberField
          label="ハートビート"
          value={draft.heartbeatSec}
          min={COLLABORATION_LIMITS.heartbeatMs.min / 1_000}
          max={COLLABORATION_LIMITS.heartbeatMs.max / 1_000}
          step={0.25}
          unit="秒"
          hint="セッション生存確認の間隔"
          onChange={(heartbeatSec) => setDraft((current) => ({ ...current, heartbeatSec }))}
        />
        <NumberField
          label="リース TTL"
          value={draft.leaseTtlSec}
          min={COLLABORATION_LIMITS.leaseTtlMs.min / 1_000}
          max={COLLABORATION_LIMITS.leaseTtlMs.max / 1_000}
          step={1}
          unit="秒"
          hint="接続中は自動更新されます"
          onChange={(leaseTtlSec) => setDraft((current) => ({ ...current, leaseTtlSec }))}
        />
        <NumberField
          label="無応答判定"
          value={draft.stuckAfterSec}
          min={COLLABORATION_LIMITS.stuckAfterMs.min / 1_000}
          max={COLLABORATION_LIMITS.stuckAfterMs.max / 1_000}
          step={1}
          unit="秒"
          hint="進捗がないセッションを stuck と表示するまでの時間"
          onChange={(stuckAfterSec) => setDraft((current) => ({ ...current, stuckAfterSec }))}
        />
        <NumberField
          label="Ask タイムアウト"
          value={draft.askTimeoutSec}
          min={COLLABORATION_LIMITS.askTimeoutMs.min / 1_000}
          max={COLLABORATION_LIMITS.askTimeoutMs.max / 1_000}
          step={1}
          unit="秒"
          hint="他セッションへの質問の待ち時間"
          onChange={(askTimeoutSec) => setDraft((current) => ({ ...current, askTimeoutSec }))}
        />
        <NumberField
          label="活動フィード上限"
          value={draft.activityLimit}
          min={COLLABORATION_LIMITS.activityLimit.min}
          max={COLLABORATION_LIMITS.activityLimit.max}
          step={1}
          unit="件"
          onChange={(activityLimit) => setDraft((current) => ({ ...current, activityLimit }))}
        />
      </div>

      <div className="mt-4 space-y-3">
        <h3 className="text-sm font-medium">チェックコマンド</h3>
        <p className="text-[11px] text-faint">
          `leafcode_check` が使う固定レジストリです。引数は空白区切り（スペースを含む値は引用符）、または JSON 配列で指定します。
        </p>
        {COLLABORATION_CHECK_IDS.map((id) => (
          <div key={id} className="grid gap-2 sm:grid-cols-[6rem_8rem_1fr] sm:items-center">
            <span className="text-sm text-muted">{CHECK_LABELS[id]}</span>
            <input
              value={draft.checks[id].file}
              aria-label={`${CHECK_LABELS[id]} のコマンド`}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  checks: { ...current.checks, [id]: { ...current.checks[id], file: event.target.value } },
                }))
              }
              className="h-9 rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm outline-none focus:border-border-strong"
            />
            <input
              value={draft.checks[id].args}
              aria-label={`${CHECK_LABELS[id]} の引数`}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  checks: { ...current.checks, [id]: { ...current.checks[id], args: event.target.value } },
                }))
              }
              className="h-9 rounded-lg border border-border bg-surface-2 px-3 font-mono text-sm outline-none focus:border-border-strong"
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          busy={saving}
          disabled={loading || saving || !dirty}
          onClick={() => void save(draft)}
        >
          保存
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading || saving}
          onClick={() => {
            setDraft(configToDraft(DEFAULT_COLLABORATION_CONFIG));
            setNotice(null);
          }}
        >
          既定値に戻す
        </Button>
      </div>

      {snapshot?.path && (
        <p className="mt-3 break-all font-mono text-[11px] text-faint">
          {snapshot.path}
          {snapshot.exists ? "" : "（未作成・保存時に作成）"}
        </p>
      )}
      {notice && <p className="mt-2 text-sm text-success">{notice}</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
