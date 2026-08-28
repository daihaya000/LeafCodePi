"use client";

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { getJson } from "@/lib/client";

/** アカウントIDから表示用ラベルを取得する。未設定は既定アカウントとして null を返す。 */
export function useTaskAccountLabel(accountId?: string | null): string | null {
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

  return label;
}

/** タスクに紐づく利用アカウント表示（docs/plans/multi-account.md）。 */
export function TaskAccountBadge({
  accountId,
  className,
}: {
  accountId?: string | null;
  className?: string;
}) {
  const label = useTaskAccountLabel(accountId);
  if (!accountId || !label) return null;
  return (
    <span className={className}>
      <UserRound className="mr-0.5 inline h-3 w-3 align-[-1px]" aria-hidden />
      {label}
    </span>
  );
}
