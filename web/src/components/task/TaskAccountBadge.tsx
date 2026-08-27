"use client";

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { getJson } from "@/lib/client";

/**
 * タスクヘッダー用の利用アカウント表示（docs/plans/multi-account.md）。
 * accountId 未設定 = 既定のため何も表示しない。一覧取得に失敗した場合は ID をそのまま出す。
 */
export function TaskAccountBadge({
  accountId,
  className,
}: {
  accountId?: string | null;
  className?: string;
}) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(null);
    if (!accountId) return;
    let cancelled = false;
    getJson<{ accounts: { id: string; label: string }[] }>("/api/accounts")
      .then((res) => {
        if (cancelled) return;
        setLabel(res.accounts.find((account) => account.id === accountId)?.label ?? accountId);
      })
      .catch(() => {
        if (!cancelled) setLabel(accountId);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (!accountId || !label) return null;
  return (
    <span className={className}>
      <UserRound className="mr-0.5 inline h-3 w-3 align-[-1px]" aria-hidden />
      {label}
    </span>
  );
}
