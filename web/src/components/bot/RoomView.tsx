"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Settings2, Users, X } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import type { BotDto, RoomDto } from "@/lib/types";
import { Button } from "@/components/ui";
import { BotAvatar } from "@/components/bot/BotAvatar";

export function RoomView({ id }: { id: string }) {
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [prompt, setPrompt] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const router = useRouter();

  const load = useCallback(() => {
    return Promise.all([
      getJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`),
      getJson<{ bots: BotDto[] }>("/api/bots"),
    ])
      .then(([roomResult, botResult]) => { setRoom(roomResult.room); setBots(botResult.bots); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました"));
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const source = new EventSource(`/api/bots/rooms/${encodeURIComponent(id)}/events?epoch=${Date.now()}`);
    source.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { room?: RoomDto };
        if (payload.room) setRoom(payload.room);
      } catch { setError("イベントの解析に失敗しました"); }
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [id]);

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const members = useMemo(
    () => (room ? room.members.map((memberId) => botById.get(memberId)).filter((bot): bot is BotDto => Boolean(bot)) : []),
    [botById, room],
  );

  const saveMembers = async (next: string[]) => {
    if (!room) return;
    try {
      const result = await sendJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`, { members: next }, "PATCH");
      setRoom(result.room);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "メンバーの保存に失敗しました"); }
  };

  const removeRoom = async () => {
    if (!room || deleting || !window.confirm(`「${room.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await sendJson(`/api/bots/rooms/${encodeURIComponent(id)}`, undefined, "DELETE");
      router.push("/bots");
    } catch (reason) {
      setDeleting(false);
      setError(reason instanceof Error ? reason.message : "ルームの削除に失敗しました");
    }
  };

  const send = async () => {
    const value = prompt.trim();
    if (!value || busy) return;
    setPrompt("");
    setError(null);
    setBusy(true);
    try {
      const result = await sendJson<{ room: RoomDto; routedBotIds?: string[] }>(
        `/api/bots/rooms/${encodeURIComponent(id)}/prompt`,
        { prompt: value, broadcast },
      );
      if (result.room) setRoom(result.room);
      if (result.routedBotIds && result.routedBotIds.length === 0) {
        setError("応答するボットがいません。@ボット名 でメンションするか「部屋に聞く」を有効にしてください。");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "リクエストに失敗しました"); }
    finally { setBusy(false); }
  };

  const rendered = useMemo(() => (room?.messages ?? []).map((message) => {
    const user = message.role === "user";
    const bot = message.botId ? botById.get(message.botId) : undefined;
    const text = message.text || (message.status === "working" ? "応答中…" : "");
    if (!text) return null;
    return (
      <div key={message.id} className={`flex items-end gap-2 ${user ? "justify-end" : "justify-start"}`}>
        {!user && <BotAvatar size={28} color={bot?.avatarColor} name={bot?.name ?? message.botName} />}
        <div className={`max-w-[min(42rem,88%)] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${user ? "rounded-br-md bg-accent text-white" : "rounded-bl-md border border-border bg-surface"}`}>
          {!user && <div className="mb-1 text-[11px] text-muted">{bot?.name ?? message.botName ?? "ボット"}</div>}
          <div className="whitespace-pre-wrap break-words">{text}</div>
          {message.status === "error" && <div className="mt-1 text-xs text-danger">応答に失敗しました</div>}
        </div>
      </div>
    );
  }), [botById, room?.messages]);

  if (!room) return <div className="p-5 text-sm text-muted">{error ?? "読み込み中…"}</div>;

  const working = room.messages.some((message) => message.status === "working");

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="relative flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Link href="/bots" aria-label="ボット一覧へ戻る" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"><ArrowLeft className="h-4 w-4" /></Link>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1"><h1 className="truncate font-semibold">{room.name}</h1><p className="text-xs text-muted">ルーム・{room.members.length} 人</p></div>
        <button
          type="button"
          aria-expanded={settingsOpen}
          aria-controls="room-settings-panel"
          onClick={() => setSettingsOpen((open) => !open)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
        >
          <Settings2 className="h-3.5 w-3.5" />設定
        </button>
      </header>


      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {room.messages.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-surface/50 px-5 py-8 text-center">
              <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-5 w-5" /></span>
              <p className="font-medium">{room.name} で話す</p>
              <p className="mt-1 text-sm text-muted">メンションされたボットだけが応答します。@everyone または「部屋に聞く」で全員に送れます。</p>
              {members.length > 0 && <div className="mt-3 flex flex-wrap justify-center gap-2">{members.map((bot) => <span key={bot.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-xs"><BotAvatar size={18} color={bot.avatarColor} name={bot.name} />{bot.name}</span>)}</div>}
            </div>
          )}
          {rendered}
          {working && <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />応答中…</div>}
        </div>
      </main>

      <div className="shrink-0 border-t border-border bg-bg px-3 py-3">
        <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface px-3 py-2 shadow-sm focus-within:border-accent/60">
          <div className="flex items-end gap-2">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composingRef.current) { event.preventDefault(); void send(); } }}
              placeholder={broadcast ? `${room.name}の全員にメッセージ` : "@ボット名 にメッセージ"}
              rows={1}
              className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-faint"
            />
            <button type="button" aria-label="添付または追加" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"><Plus className="h-4 w-4" /></button>
            <Button onClick={() => void send()} disabled={!prompt.trim() || busy}>送信</Button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
            <button type="button" aria-pressed={broadcast} onClick={() => setBroadcast((value) => !value)} className="truncate hover:text-text">送信先: {broadcast ? "全員（部屋に聞く）" : "メンションしたボット"}</button>
            <button type="button" onClick={() => setSettingsOpen(true)} className="shrink-0 hover:text-text">メンバー: {room.members.length}</button>
          </div>
        </div>
        {error && <p role="alert" className="mx-auto mt-2 max-w-3xl text-xs text-danger">{error}</p>}
      </div>
      </div>
      {settingsOpen && (
        <aside id="room-settings-panel" aria-label="ルーム設定" className="flex h-full w-[min(100%,22rem)] shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
            <div><h2 className="font-semibold">ルーム設定</h2><p className="mt-0.5 text-xs text-muted">このルームのメンバーと送信先を設定</p></div>
            <button type="button" aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            <div className="flex flex-col items-center gap-2 py-2"><span className="flex h-20 w-20 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-8 w-8" /></span><p className="text-xs text-muted">ルームのプロフィール</p></div>
            <label className="block text-sm"><span className="font-medium">名前</span><div className="mt-2 rounded-xl border border-border bg-bg px-3 py-2.5">{room.name}</div></label>
            <div className="rounded-2xl border border-border bg-bg p-4">
              <span className="text-sm font-medium">メンバー</span>
              <div className="mt-3 space-y-1">
                {bots.map((bot) => (
                  <label key={bot.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={room.members.includes(bot.id)}
                      onChange={(event) => void saveMembers(event.target.checked ? [...room.members, bot.id] : room.members.filter((item) => item !== bot.id))}
                    />
                    <BotAvatar size={24} color={bot.avatarColor} name={bot.name} />
                    <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                  </label>
                ))}
                {bots.length === 0 && <p className="px-2 py-2 text-xs text-muted">ボットがありません</p>}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <div><span className="text-sm font-medium">部屋に聞く</span><p className="mt-0.5 text-xs text-muted">有効にすると、メンションなしでもメンバー全員が応答します。</p></div>
                <Button size="sm" variant={broadcast ? "primary" : "ghost"} onClick={() => setBroadcast((value) => !value)} aria-pressed={broadcast}>{broadcast ? "全員" : "メンション"}</Button>
              </div>
            </div>
            <div className="border-t border-border pt-4">
              <p className="text-xs text-muted">このルームの会話履歴も削除されます。</p>
              <Button size="sm" variant="danger" onClick={() => void removeRoom()} busy={deleting} className="mt-2">ルームを削除</Button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
