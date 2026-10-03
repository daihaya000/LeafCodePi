"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

const LABEL_MAX = 100;

type PeerRow = { id: string; label: string; peerUrl: string; providers: string[]; online: boolean };

/** B-side import of another LCP's shared credentials (docs/plans/peer-auth-share.md). */
export function PeerImportSettings({ onImported }: { onImported?: () => void }) {
  const [peerUrl, setPeerUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [peersLoading, setPeersLoading] = useState(true);

  const loadPeers = useCallback(() => {
    setPeersLoading(true);
    void getJson<{ peers: PeerRow[] }>("/api/peer-auth/import")
      .then((result) => setPeers(result.peers))
      .catch(() => setPeers([]))
      .finally(() => setPeersLoading(false));
  }, []);

  useEffect(() => {
    loadPeers();
  }, [loadPeers]);

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
      loadPeers();
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "取り込みに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function remove(peer: PeerRow) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await sendJson(`/api/accounts/${encodeURIComponent(peer.id)}`, {}, "DELETE");
      loadPeers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
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

      {peersLoading ? (
        <p className="mt-4 text-xs text-muted">接続元の状態を確認中…</p>
      ) : peers.length > 0 ? (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {peers.map((peer) => (
            <li key={peer.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{peer.label}</p>
                <p className="text-xs text-muted">{peer.peerUrl}・{peer.providers.join("、")}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={peer.online ? "success" : "warning"}>{peer.online ? "オンライン" : "オフライン"}</Badge>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove(peer)}>
                  削除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-muted">取り込んだアカウントはありません。</p>
      )}
    </div>
  );
}
