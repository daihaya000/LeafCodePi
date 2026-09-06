"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Settings2, Users } from "lucide-react";
import { BotAvatar } from "@/components/bot/BotAvatar";

export function BotChatHeader({
  title,
  subtitle,
  bot,
  settingsOpen,
  onSettings,
  action,
}: {
  title: string;
  subtitle: string;
  bot?: { name: string; avatarColor?: string; avatarImage?: string | null };
  settingsOpen: boolean;
  onSettings: () => void;
  action?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
      <Link href={bot ? "/bots" : "/bots"} aria-label="ボット一覧へ戻る" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text">
        <ArrowLeft className="h-4 w-4" />
      </Link>
      {bot ? <BotAvatar size={36} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-4 w-4" /></span>}
      <button type="button" onClick={onSettings} aria-label="ボット設定を開く" className="min-w-0 flex-1 text-left hover:opacity-80"><h1 className="truncate font-semibold">{title}</h1><p className="text-xs text-muted">{subtitle}</p></button>
      {action}
      <button type="button" aria-expanded={settingsOpen} onClick={onSettings} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text">
        <Settings2 className="h-3.5 w-3.5" />設定
      </button>
    </header>
  );
}
