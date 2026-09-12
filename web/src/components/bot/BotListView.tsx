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

  async function createFromTemplate(templateId: string) {
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
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <MobileMenuHeader />
      <div className="min-w-0 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
        <h1 className="text-lg font-semibold">Bot一覧</h1>
        <p className="mt-1 text-xs text-muted">1:1 会話用のBotを管理します。</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:space-y-6 sm:p-5">
        <section aria-labelledby="my-bots-heading">
          <h2 id="my-bots-heading" className="text-sm font-semibold">マイボット</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {bots.map((bot) => <Link key={bot.id} href={`/bots/${bot.id}`} className="min-w-0 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"><div className="flex min-w-0 items-center gap-3"><span className="relative shrink-0"><BotAvatar size={40} {...bot} />{bot.codeSessionCount ? <span aria-label={`Codeセッション${bot.codeSessionCount}件`} title={`Codeセッション${bot.codeSessionCount}件`} className="absolute -bottom-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full border-2 border-surface bg-accent px-1 text-[10px] font-semibold leading-3 text-white">{bot.codeSessionCount}</span> : null}</span><span className="min-w-0 flex-1 truncate font-medium">{bot.name}</span><span className="shrink-0 text-xs text-muted">{bot.enabled ? "有効" : "無効"}</span></div><p className="mt-2 line-clamp-2 break-words text-xs text-muted">{bot.soul.replace(/^#.*$/m, "").trim() || "SOUL.md はまだありません"}</p></Link>)}
            {bots.length === 0 && <BotEmptyState title="ボットはまだありません" description="テンプレートまたは作成フォームから最初のボットを作成できます。" />}
          </div>
        </section>

        <section aria-labelledby="marketplace-heading">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 id="marketplace-heading" className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-accent" />テンプレート</h2>
              <p className="mt-1 text-xs text-muted">小さなスターターから複製して始められます。</p>
            </div>
            <span className="shrink-0 text-[11px] text-muted">{BOT_TEMPLATES.length} 件</span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {BOT_TEMPLATES.map((template) => (
              <article key={template.id} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/60">
                <h3 className="font-medium">{template.name}</h3>
                <p className="mt-1 text-xs font-medium text-accent">{template.label}</p>
                <p className="mt-2 flex-1 text-xs leading-5 text-muted">{template.description}</p>
                <Button size="sm" variant="ghost" onClick={() => void createFromTemplate(template.id)} busy={templateBusy === template.id} disabled={busy || templateBusy !== null} className="mt-3 min-h-11 w-full justify-center sm:min-h-0"><CopyPlus className="mr-1.5 h-3.5 w-3.5" />使ってみる</Button>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="new-bot-heading" className="rounded-2xl border border-border bg-surface p-4">
          <h2 id="new-bot-heading" className="text-sm font-semibold">新しいボット</h2>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="ボット名（例: リサーチャー）" aria-label="新しいボットの名前" className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-accent sm:h-10" />
            <Button onClick={() => void create()} busy={busy} disabled={!name.trim()} className="min-h-11 w-full sm:min-h-0 sm:w-auto">作成</Button>
          </div>
        </section>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}
