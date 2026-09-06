"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getJson, sendJson } from "@/lib/client";
import type { BotDto } from "@/lib/types";
import { Button } from "@/components/ui";

export function BotListView() {
  const [bots, setBots] = useState<BotDto[]>([]); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const router = useRouter();
  const refresh = () => void getJson<{ bots: BotDto[] }>("/api/bots").then((r) => setBots(r.bots)).catch(() => undefined);
  useEffect(refresh, []);
  async function create() { if (busy) return; setBusy(true); try { const r = await sendJson<{ bot: BotDto }>("/api/bots", { name }); setName(""); router.push(`/bots/${r.bot.id}`); } finally { setBusy(false); } }
  return <div className="flex h-full flex-col">
    <div className="border-b border-border px-5 py-4"><h1 className="text-lg font-semibold">Bots</h1><p className="mt-1 text-xs text-muted">Named assistants for private 1:1 conversations.</p></div>
    <div className="mx-auto w-full max-w-3xl space-y-5 overflow-y-auto p-5">
      <div className="flex gap-2"><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} placeholder="Bot name (e.g. Researcher)" className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent" /><Button onClick={() => void create()} busy={busy}>Create</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">{bots.map((bot) => <Link key={bot.id} href={`/bots/${bot.id}`} className="rounded-xl border border-border bg-surface p-4 hover:border-accent"><div className="flex items-center justify-between"><span className="font-medium">{bot.name}</span><span className="text-xs text-muted">{bot.enabled ? "Enabled" : "Disabled"}</span></div><p className="mt-2 line-clamp-2 text-xs text-muted">{bot.soul.replace(/^#.*$/m, "").trim() || "No SOUL.md"}</p></Link>)}{bots.length === 0 && <p className="text-sm text-muted">No bots yet</p>}</div>
    </div>
  </div>;
}
