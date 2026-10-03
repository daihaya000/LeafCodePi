"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type Grant = { id: string; label: string; accountId: string | null; providers: string[]; createdAt: string };
type Snapshot = { enabled: boolean; authRequired: boolean; grants: Grant[] };
type ProviderOption = { id: string; name: string };
type AccountOption = { id: string; label: string };

const LABEL_MAX = 100;

/** A-side management of peer auth sharing (docs/plans/peer-auth-share.md). */
export function PeerShareSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    void Promise.all([
      getJson<Snapshot>("/api/peer-auth/peers"),
      getJson<{ providers: { id: string; name: string; authenticated: boolean }[] }>("/api/providers"),
      getJson<{ accounts: { id: string; label: string; enabled?: boolean }[] }>("/api/accounts"),
    ])
      .then(([next, auth, accountList]) => {
        setSnapshot(next);
        setProviders(auth.providers.filter((provider) => provider.authenticated).map(({ id, name }) => ({ id, name })));
        setAccounts(accountList.accounts.filter((account) => account.enabled !== false).map(({ id, label }) => ({ id, label })));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "共有設定の読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  const toggle = () =>
    run(async () => {
      setSnapshot(await sendJson<Snapshot>("/api/peer-auth/peers", { enabled: !snapshot?.enabled }, "PATCH"));
    }, "共有設定の更新に失敗しました");

  const create = () =>
    run(async () => {
      const result = await sendJson<{ grant: Grant; token: string }>("/api/peer-auth/peers", { label: label.trim(), providers: selected, accountId: accountId || null }, "POST");
      setIssued({ label: result.grant.label, token: result.token });
      setLabel("");
      setSelected([]);
      setSnapshot(await getJson<Snapshot>("/api/peer-auth/peers"));
    }, "共有先の作成に失敗しました");

  const revoke = (grant: Grant) =>
    run(async () => {
      setSnapshot(await sendJson<Snapshot>(`/api/peer-auth/peers?id=${encodeURIComponent(grant.id)}`, {}, "DELETE"));
      setIssued((current) => (current?.label === grant.label ? null : current));
    }, "共有先の失効に失敗しました");

  const disabled = loading || busy;
  const canCreate = !disabled && label.trim().length > 0 && label.trim().length <= LABEL_MAX && selected.length > 0;
  const badge = !snapshot
    ? { label: "読み込み中", tone: "neutral" as const }
    : snapshot.enabled
      ? { label: "共有中", tone: "success" as const }
      : { label: "停止中", tone: "neutral" as const };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">認証情報の共有</h3>
          <p className="mt-1 text-xs text-muted">
            同じネットワーク内の別のLCPへ、このLCPのプロバイダ認証を提供します。更新（refresh）はこのLCPだけが行います。
          </p>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <p className="rounded-xl border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
        トークンと認証情報は暗号化されずに流れます。信頼できるLAN、またはTailscale経由でのみ使ってください。
      </p>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Switch checked={snapshot?.enabled === true} onChange={() => void toggle()} label="認証情報の共有" disabled={disabled || !snapshot || (!snapshot.enabled && !snapshot.authRequired)} />
          <span className="text-sm font-medium">共有を{snapshot?.enabled ? "停止" : "開始"}する</span>
        </div>
        {snapshot && !snapshot.authRequired && (
          <p className="text-xs text-muted">共有を開始するには、WebUIアクセスのゲートを有効にしてリモート接続を保護してください。</p>
        )}

        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">共有先の名前</span>
          <input
            value={label}
            maxLength={LABEL_MAX}
            disabled={disabled}
            onChange={(event) => setLabel(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-border-strong disabled:opacity-50"
            placeholder="例: ノートPC"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">共有するアカウント</span>
          <select
            value={accountId}
            disabled={disabled}
            onChange={(event) => setAccountId(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-border-strong disabled:opacity-50"
          >
            <option value="">既定（~/.pi/agent/auth.json）</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label}</option>
            ))}
          </select>
        </label>

        <fieldset className="text-sm" disabled={disabled}>
          <legend className="mb-1.5 text-muted">共有するプロバイダ（既定アカウントでログイン済みのもの）</legend>
          {providers.length === 0 ? (
            <p className="text-xs text-muted">共有できるログイン済みプロバイダがありません。</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {providers.map((provider) => (
                <label key={provider.id} className="flex min-h-8 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(provider.id)}
                    onChange={(event) =>
                      setSelected((current) => (event.target.checked ? [...current, provider.id] : current.filter((id) => id !== provider.id)))
                    }
                  />
                  <span>{provider.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <Button type="button" variant="primary" size="sm" busy={busy} disabled={!canCreate} onClick={() => void create()}>
          共有先を追加
        </Button>
      </div>

      {issued && (
        <div className="mt-4 rounded-xl border border-border bg-surface-2 p-3" role="status">
          <p className="text-xs text-muted">「{issued.label}」のトークンです。この表示は一度きりです。共有先のLCPに入力してください。</p>
          <code className="mt-2 block break-all text-xs select-all" data-testid="peer-token">{issued.token}</code>
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setIssued(null)}>
            閉じる
          </Button>
        </div>
      )}

      {snapshot && snapshot.grants.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {snapshot.grants.map((grant) => (
            <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{grant.label}</p>
                <p className="text-xs text-muted">
                  {grant.providers.join("、")}（{grant.accountId ? accounts.find((account) => account.id === grant.accountId)?.label ?? grant.accountId : "既定"}）
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void revoke(grant)}>
                失効
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={reload}>
          再読込
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
