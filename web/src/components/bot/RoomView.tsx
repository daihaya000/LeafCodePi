"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, X } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import { markRead } from "@/lib/bot-unread";
import type { BotDto, RoomDto } from "@/lib/types";
import { Button } from "@/components/ui";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { BotEmptyState } from "@/components/bot/BotEmptyState";
import { BotChatHeader } from "@/components/bot/BotChatHeader";
import { BotComposer } from "@/components/bot/BotComposer";
import { BotMessageList, BotMessageTime } from "@/components/bot/BotMessageList";

type MentionContext = { start: number; end: number; query: string };
type MentionCandidate = { key: string; value: string; label: string; description: string; bot?: BotDto };

const SPECIAL_MENTIONS: MentionCandidate[] = [
  { key: "special:here", value: "here", label: "@here", description: "全員にメンション" },
  { key: "special:channel", value: "channel", label: "@channel", description: "全員にメンション" },
];

function mentionContextFor(value: string, cursor: number): MentionContext | null {
  const start = value.lastIndexOf("@", cursor - 1);
  if (start < 0 || (start > 0 && !/\s/.test(value[start - 1] ?? ""))) return null;
  const query = value.slice(start + 1, cursor);
  return /^[^\s@]*$/.test(query) ? { start, end: cursor, query } : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMentionText(text: string, bots: BotDto[], keyPrefix: string, mentionClassName?: string): ReactNode[] {
  const names = ["here", "channel", "everyone", "all", ...bots.map((bot) => bot.name.trim())]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (names.length === 0) return [text];
  const pattern = new RegExp(`@(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`, "giu");
  const parts: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<span key={`${keyPrefix}-mention-${index++}`} className={mentionClassName ?? "font-semibold text-accent"}>{match[0]}</span>);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
}

export function RoomView({ id }: { id: string }) {
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [prompt, setPrompt] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [memberSaving, setMemberSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionContext, setMentionContext] = useState<MentionContext | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const composingRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
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
    const latest = room?.messages.reduce((value, message) => Math.max(value, message.createdAt), 0) ?? 0;
    if (latest > 0) markRead("room", id, latest);
  }, [id, room?.messages]);

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
  const mentionCandidates = useMemo(() => {
    if (!mentionContext) return [];
    const query = mentionContext.query.toLocaleLowerCase();
    const botCandidates = members
      .filter((bot) => bot.enabled)
      .map((bot): MentionCandidate => ({ key: `bot:${bot.id}`, value: bot.name, label: `@${bot.name}`, description: "Botにメンション", bot }));
    return [...SPECIAL_MENTIONS, ...botCandidates].filter((candidate) => !query || candidate.value.toLocaleLowerCase().includes(query));
  }, [members, mentionContext]);

  useEffect(() => { setMentionIndex(0); }, [mentionContext?.query]);

  const saveMembers = async (next: string[]) => {
    if (!room || memberSaving) return;
    setMemberSaving(true);
    setError(null);
    try {
      const result = await sendJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`, { members: next }, "PATCH");
      setRoom(result.room);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30e1\u30f3\u30d0\u30fc\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
    finally { setMemberSaving(false); }
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

  const insertMention = (candidate: MentionCandidate) => {
    if (!mentionContext) return;
    const replacement = `@${candidate.value} `;
    const nextPrompt = `${prompt.slice(0, mentionContext.start)}${replacement}${prompt.slice(mentionContext.end)}`;
    const caret = mentionContext.start + replacement.length;
    setPrompt(nextPrompt);
    setMentionContext(null);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(caret, caret);
    });
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionCandidates.length > 0 && mentionContext) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionContext(null);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]!);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
      event.preventDefault();
      void send();
    }
  };

  const send = async () => {
    const value = prompt.trim();
    if (!value || busy) return;
    setPrompt("");
    setMentionContext(null);
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
        {!user && <BotAvatar size={28} color={bot?.avatarColor} image={bot?.avatarImage} name={bot?.name ?? message.botName} active={message.status === "working"} />}
        <div className={`min-w-0 max-w-[88%] rounded-3xl px-4 py-2.5 text-base leading-6 ${user ? "bg-bot-user text-white" : "bg-bot-assistant text-text"}`}>
          {!user && <div className="mb-1 text-[11px] text-muted">{bot?.name ?? message.botName ?? "ボット"}</div>}
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderMentionText(text, bots, message.id, user ? "rounded bg-white/90 px-0.5 font-semibold text-accent" : undefined)}</div>
          {message.status === "error" && <div className="mt-1 text-xs text-danger">応答に失敗しました</div>}
          <BotMessageTime createdAt={message.createdAt} />
        </div>
      </div>
    );
  }), [botById, bots, room?.messages]);

  if (!room) return <div className="p-5 text-sm text-muted">{error ?? "読み込み中…"}</div>;

  const working = room.messages.some((message) => message.status === "working");

  return (
    <div className="flex h-full min-h-0 bg-bot-chat">
      <div className={`${settingsOpen ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
      <BotChatHeader
        title={room.name}
        subtitle={`\u30eb\u30fc\u30e0\u30fb${room.members.length} \u4eba`}
        members={members}
        active={working}
        settingsOpen={settingsOpen}
        onSettings={() => setSettingsOpen((open) => !open)}
      />


      <BotMessageList conversationId={id}>
        <div className="mx-auto w-full space-y-6">
          {room.messages.length === 0 && <BotEmptyState icon={<Users className="h-5 w-5" />} title={room.name + " \u3067\u8a71\u3059"} description="\u30e1\u30f3\u30b7\u30e7\u30f3\u3055\u308c\u305f\u30dc\u30c3\u30c8\u3060\u3051\u304c\u5fdc\u7b54\u3057\u307e\u3059\u3002@here / @channel \u307e\u305f\u306f\u300c\u90e8\u5c4b\u306b\u805e\u304f\u300d\u3067\u5168\u54e1\u306b\u9001\u308c\u307e\u3059\u3002">{members.length > 0 && <div className="mt-3 flex flex-wrap justify-center gap-2">{members.map((bot) => <span key={bot.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-xs"><BotAvatar size={18} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} />{bot.name}</span>)}</div>}</BotEmptyState>}
          {rendered}
          {working && <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />応答中…</div>}
        </div>
      </BotMessageList>

      <BotComposer
        inputRef={promptRef}
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          setMentionContext(mentionContextFor(event.target.value, event.target.selectionStart ?? event.target.value.length));
        }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={handlePromptKeyDown}
        placeholder={broadcast ? `${room.name}\u306e\u5168\u54e1\u306b\u30e1\u30c3\u30bb\u30fc\u30b8` : "@\u30dc\u30c3\u30c8\u540d \u306b\u30e1\u30c3\u30bb\u30fc\u30b8"}
        sendDisabled={!prompt.trim()}
        busy={busy}
        onSend={() => void send()}
        footer={<><button type="button" aria-pressed={broadcast} onClick={() => setBroadcast((value) => !value)} className={`rounded-full px-2 py-1 font-medium ${broadcast ? "bg-accent/10 text-accent" : "hover:bg-surface-2 hover:text-text"}`}>{broadcast ? "\u90e8\u5c4b\u306b\u805e\u304f\uff08\u5168\u54e1\uff09" : "\u90e8\u5c4b\u306b\u805e\u304f"}</button><button type="button" onClick={() => setSettingsOpen(true)} className="shrink-0 hover:text-text">{`\u30e1\u30f3\u30d0\u30fc: ${room.members.length}`}</button></>}
        inputOverlay={mentionCandidates.length > 0 ? <div id="room-mention-options" role="listbox" aria-label={"\u30e1\u30f3\u30b7\u30e7\u30f3\u5148\u5019\u88dc"} className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">{mentionCandidates.map((candidate, index) => <button key={candidate.key} type="button" role="option" aria-selected={index === mentionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(candidate)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${index === mentionIndex ? "bg-surface-2" : "hover:bg-surface-2"}`}>{candidate.bot ? <BotAvatar size={24} color={candidate.bot.avatarColor} image={candidate.bot.avatarImage} name={candidate.bot.name} /> : <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">@</span>}<span className="min-w-0"><span className="block truncate text-sm font-medium">{candidate.label}</span><span className="block truncate text-[11px] text-muted">{candidate.description}</span></span></button>)}</div> : null}
      />
      {!settingsOpen && error && <p role="alert" className="mx-auto max-w-3xl px-3 pb-2 text-xs text-danger">{error}</p>}
      </div>
      {settingsOpen && (
        <aside id="room-settings-panel" onKeyDown={(event) => { if (event.key === "Escape") setSettingsOpen(false); }} aria-label="ルーム設定" className="flex h-full w-full shrink-0 flex-col border-bot-outline bg-bot-chat lg:w-[22rem] lg:border-l xl:w-[24.5rem]">
          <div className="flex h-[3.75rem] shrink-0 items-center justify-between px-5">
            <h2 className="text-sm font-medium">ルーム設定</h2>
            <button type="button" autoFocus aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex flex-col items-center gap-2 py-2"><span className="flex h-20 w-20 items-center justify-center rounded-full bg-success-bg text-success"><Users className="h-8 w-8" /></span><p className="text-xs text-muted">ルームのプロフィール</p></div>
            <label className="block text-sm"><span className="font-medium">名前</span><div className="mt-2 rounded-xl border border-border bg-bg px-3 py-2.5">{room.name}</div></label>
            <div className="rounded-2xl border border-border bg-bg p-4">
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{"\u30e1\u30f3\u30d0\u30fc"}</span><span className="text-xs text-muted">{room.members.length}{"\u4eba\u9078\u629e"}</span></div>
              <div className="mt-3 space-y-1">
                {bots.map((bot) => (
                  <label key={bot.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-2">
                    <input
                      type="checkbox"
                      aria-label={`\u30dc\u30c3\u30c8\u540d: ${bot.name} / ${room.members.includes(bot.id) ? "\u8a2d\u5b9a\u6e08\u307f" : "\u8ffd\u52a0"}`}
                      disabled={memberSaving}
                      checked={room.members.includes(bot.id)}
                      onChange={(event) => void saveMembers(event.target.checked ? [...room.members, bot.id] : room.members.filter((item) => item !== bot.id))}
                    />
                    <BotAvatar size={24} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} />
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
