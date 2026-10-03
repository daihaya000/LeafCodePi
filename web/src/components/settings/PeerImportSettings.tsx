"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { sendJson } from "@/lib/client";

const LABEL_MAX = 100;

/** B-side import of another LCP's shared credentials (docs/plans/peer-auth-share.md). */
export function PeerImportSettings({ onImported }: { onImported?: () => void }) {
  const [peerUrl, setPeerUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const ready = peerUrl.trim().length > 0 && token.trim().length > 0 && label.trim().length > 0 && label.trim().length <= LABEL_MAX;

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendJson<{ account: { label: string; providers: string[] } }>(
        "/api/peer-auth/import",
        { peerUrl: peerUrl.trim(), token: token.trim(), label: label.trim() },
        "POST",
      );
      // The token now lives only in the new account's peer.json; never keep it in the form.
      setToken("");
      setPeerUrl("");
      setLabel("");
      setNotice(`「${result.account.label}」を追加しました（${result.account.providers.join("、")}）。`);
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "取り込みに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">別のLCPから認証情報を取り込む</h3>
      <p className="mt-1 text-xs text-muted">
        共有元のLCPで発行したトークンを入力すると、その認証情報を使うアカウントを追加します。認証情報はこのPCには保存されず、使うたびに共有元から取得します。共有元が起動していない間は使えません。
      </p>

      <div className="mt-4 space-y-3">
        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">共有元のURL</span>
          <input
            value={peerUrl}
            disabled={busy}
            onChange={(event) => setPeerUrl(event.target.value)}
            inputMode="url"
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-border-strong disabled:opacity-50"
            placeholder="例: http://100.64.0.2:3000"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">トークン</span>
          <input
            type="password"
            value={token}
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-border-strong disabled:opacity-50"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block text-muted">アカウント名</span>
          <input
            value={label}
            maxLength={LABEL_MAX}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-border-strong disabled:opacity-50"
            placeholder="例: メインPCの認証"
          />
        </label>
      </div>

      <div className="mt-4">
        <Button type="button" variant="primary" size="sm" busy={busy} disabled={!ready || busy} onClick={() => void submit()}>
          取り込む
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="mt-2 text-sm text-success" role="status">{notice}</p>}
    </div>
  );
}
