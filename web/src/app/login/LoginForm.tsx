"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/webui", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "トークンが正しくありません");
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError("接続に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold">LeafCodePi にサインイン</h1>
        <p className="mt-2 text-sm text-muted">
          リモートアクセス用トークンを入力してください。ホスト起動ログまたは{" "}
          <code className="rounded bg-surface-2 px-1">%APPDATA%\leafcode-pi\webui-auth.json</code>{" "}
          を確認できます。
        </p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">アクセス トークン</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="起動時に表示されたトークン"
              required
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
          >
            {busy ? "確認中…" : "続行"}
          </button>
        </form>
      </div>
    </main>
  );
}
