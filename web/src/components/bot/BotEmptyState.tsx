import type { ReactNode } from "react";
import { BotAvatar, type BotFace } from "@/components/bot/BotAvatar";

export function BotEmptyState({
  title,
  description,
  icon,
  avatar,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  avatar?: BotFace & { name: string };
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-bot-outline bg-bot-panel px-5 py-8 text-center">
      {avatar ? (
        <BotAvatar size={48} {...avatar} className="mx-auto mb-3" />
      ) : icon ? (
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success-bg text-success">{icon}</div>
      ) : null}
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-sm text-muted">{description}</p>
      {children}
    </div>
  );
}
