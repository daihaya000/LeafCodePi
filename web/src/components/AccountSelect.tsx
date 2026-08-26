"use client";

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { GhostSelect } from "@/components/ui";
import { getJson } from "@/lib/client";

type AccountOption = { id: string; label: string };

/**
 * タスクで使う認証アカウントの選択（docs/plans/multi-account.md Phase 5）。
 * アカウントが 1 件も無ければ何も表示しない（既定のみの運用ではノイズになるため）。
 */
export function AccountSelect({
  value,
  onChange,
  disabled = false,
  className = "max-w-[9rem] shrink-0",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<{ accounts: AccountOption[] }>("/api/accounts")
      .then((res) => {
        if (!cancelled) setAccounts(res.accounts);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = accounts ?? [];
  // 未取得のうちは既定ラベルで表示（選択肢は取得後に現れる）
  if (accounts !== null && options.length === 0) return null;

  const current = options.find((account) => account.id === value);

  return (
    <GhostSelect
      value={current ? current.id : ""}
      disabled={disabled}
      aria-label="アカウント"
      icon={<UserRound className="h-3.5 w-3.5" />}
      valueLabel={current ? current.label : "既定"}
      onChange={(next) => onChange(next === "" ? null : next)}
      className={className}
    >
      <option value="">既定</option>
      {options.map((account) => (
        <option key={account.id} value={account.id}>
          {account.label}
        </option>
      ))}
    </GhostSelect>
  );
}
