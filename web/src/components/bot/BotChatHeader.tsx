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
      <button type="button" onClick={onSettings} aria-label={"\u8a2d\u5b9a\u3092\u958b\u304f"} className="shrink-0 rounded-full hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{bot ? <BotAvatar size={36} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} /> : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-4 w-4" /></span>}</button>
      <button type="button" onClick={onSettings} aria-label="ボット設定を開く" className="min-w-0 flex-1 text-left hover:opacity-80"><h1 className="truncate font-semibold">{title}</h1><p className="text-xs text-muted">{subtitle}</p></button>
      {action}
      <button type="button" aria-label={"\u8a2d\u5b9a"} title={"\u8a2d\u5b9a"} aria-expanded={settingsOpen} onClick={onSettings} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text">
        <Settings2 className="h-4 w-4" />
      </button>
    </header>
  );
}
