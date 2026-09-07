"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyPlus, Sparkles } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import { notifyBotSidebarChanged } from "@/lib/events";
import type { BotDto } from "@/lib/types";
import { BOT_TEMPLATES } from "@/lib/bot-marketplace";
import { Button } from "@/components/ui";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { BotEmptyState } from "@/components/bot/BotEmptyState";
import { MobileMenuHeader } from "@/components/shell/MobileMenuHeader";

export function BotListView() {
  const [bots, setBots] = useState<BotDto[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [templateBusy, setTemplateBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = () => void getJson<{ bots: BotDto[] }>("/api/bots").then((result) => setBots(result.bots)).catch(() => undefined);
  useEffect(refresh, []);

  async function create(input: { name?: string; templateId?: string } = {}) {
    if (busy || templateBusy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>("/api/bots", {
        ...(input.name === undefined ? { name } : { name: input.name }),
        ...(input.templateId ? { templateId: input.templateId } : {}),
      });
      setName("");
      notifyBotSidebarChanged();
      router.push(`/bots/${result.bot.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ボットの作成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function useTemplate(templateId: string) {
    if (busy || templateBusy) return;
    setTemplateBusy(templateId);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>("/api/bots", { templateId });
      notifyBotSidebarChanged();
      router.push(`/bots/${result.bot.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "テンプレートからの作成に失敗しました");
    } finally {
      setTemplateBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <MobileMenuHeader />
      <div className="border-b border-border px-5 py-4">
        <h1 className="text-lg font-semibold">ボット</h1>
        <p className="mt-1 text-xs text-muted">1:1 会話用のボットを管理します。</p>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-6 overflow-y-auto p-5">
        <section aria-labelledby="new-bot-heading" className="rounded-2xl border border-border bg-surface p-4">
          <h2 id="new-bot-heading" className="text-sm font-semibold">新しいボット</h2>
          <div className="mt-3 flex gap-2">
            <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="ボット名（例: リサーチャー）" aria-label="新しいボットの名前" className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-accent" />
            <Button onClick={() => void create()} busy={busy} disabled={!name.trim()}>作成</Button>
          </div>
        </section>

        <section aria-labelledby="marketplace-heading">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="marketplace-heading" className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-accent" />テンプレート</h2>
              <p className="mt-1 text-xs text-muted">小さなスターターから複製して始められます。</p>
            </div>
            <span className="text-[11px] text-muted">{BOT_TEMPLATES.length} 件</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {BOT_TEMPLATES.map((template) => (
              <article key={template.id} className="flex flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/60">
                <h3 className="font-medium">{template.name}</h3>
                <p className="mt-1 text-xs font-medium text-accent">{template.label}</p>
                <p className="mt-2 flex-1 text-xs leading-5 text-muted">{template.description}</p>
                <Button size="sm" variant="ghost" onClick={() => void useTemplate(template.id)} busy={templateBusy === template.id} disabled={busy || templateBusy !== null} className="mt-3 w-full justify-center"><CopyPlus className="mr-1.5 h-3.5 w-3.5" />使ってみる</Button>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="my-bots-heading">
          <h2 id="my-bots-heading" className="text-sm font-semibold">マイボット</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {bots.map((bot) => <Link key={bot.id} href={`/bots/${bot.id}`} className="rounded-xl border border-border bg-surface p-4 hover:border-accent"><div className="flex items-center gap-3"><BotAvatar size={40} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} /><span className="min-w-0 flex-1 truncate font-medium">{bot.name}</span><span className="text-xs text-muted">{bot.enabled ? "有効" : "無効"}</span></div><p className="mt-2 line-clamp-2 text-xs text-muted">{bot.soul.replace(/^#.*$/m, "").trim() || "SOUL.md はまだありません"}</p></Link>)}
            {bots.length === 0 && <BotEmptyState title="ボットはまだありません" description="上の作成フォームか、テンプレートから最初のボットを作成できます。" />}
          </div>
        </section>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
