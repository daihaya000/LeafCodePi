"use client";

import { type ReactNode, useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Settings2, Users } from "lucide-react";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { MobileMenuButton } from "@/components/shell/MobileMenuHeader";

type HeaderMember = { id: string; name: string; avatarColor?: string; avatarImage?: string | null };

export function BotChatHeader({
  title,
  subtitle,
  bot,
  members = [],
  active = false,
  settingsOpen,
  onSettings,
  action,
}: {
  title: string;
  subtitle: string;
  bot?: { name: string; avatarColor?: string; avatarImage?: string | null };
  members?: HeaderMember[];
  active?: boolean;
  settingsOpen: boolean;
  onSettings: () => void;
  action?: ReactNode;
}) {
  const settingsButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(settingsOpen);
  useEffect(() => {
    if (wasOpen.current && !settingsOpen) settingsButton.current?.focus();
    wasOpen.current = settingsOpen;
  }, [settingsOpen]);
  const visibleMembers = members.slice(0, 3);
  const extraCount = Math.max(0, members.length - visibleMembers.length);
  return (
    <header className="flex h-[3.75rem] shrink-0 items-center gap-2 border-b border-bot-outline bg-bot-chat px-4">
      <MobileMenuButton />
      <Link href="/bots" aria-label="ボット一覧へ戻る" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text md:hidden">
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <button type="button" onClick={onSettings} aria-label={settingsOpen ? "設定を閉じる" : "設定を開く"} aria-expanded={settingsOpen} className="shrink-0 rounded-full hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {bot ? <BotAvatar size={32} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} active={active} /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-4 w-4" /></span>}
      </button>
      <button type="button" onClick={onSettings} aria-label={settingsOpen ? "設定を閉じる" : "ボット設定を開く"} aria-expanded={settingsOpen} className="min-w-0 flex-1 text-left hover:opacity-80">
        <h1 className="truncate text-sm font-medium">{title}</h1>
        <p className="truncate text-[11px] leading-4 text-muted">{subtitle}</p>
      </button>
      {members.length > 0 && <div className="flex shrink-0 -space-x-2" aria-label={`メンバー ${members.length}人`}>
        {visibleMembers.map((member) => <BotAvatar key={member.id} size={26} color={member.avatarColor} image={member.avatarImage} name={member.name} className="ring-2 ring-surface" />)}
        {extraCount > 0 && <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-muted ring-2 ring-surface">+{extraCount}</span>}
      </div>}
      {action}
      <button ref={settingsButton} type="button" aria-label="設定" title="設定" aria-expanded={settingsOpen} onClick={onSettings} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text">
        <Settings2 className="h-4 w-4" />
      </button>
    </header>
  );
}
