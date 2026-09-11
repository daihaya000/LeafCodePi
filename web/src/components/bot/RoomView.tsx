"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, X } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import { notifyBotSidebarChanged } from "@/lib/events";
import { markRead } from "@/lib/bot-unread";
import type { SkillDto } from "@/lib/skills";
import { decideNotification } from "@/lib/notify";
import type { BotDto, QuestionRequestDto, RoomAttention, RoomDto, RoomHandoffState, RoomMessage } from "@/lib/types";
import { QuestionCard } from "@/components/task/QuestionCard";
import { Button } from "@/components/ui";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { BotEmptyState } from "@/components/bot/BotEmptyState";
import { BotChatHeader } from "@/components/bot/BotChatHeader";
import { conversationContentClass } from "@/components/ConversationLayout";
import { BotComposer } from "@/components/bot/BotComposer";
import { BotMessageError, BotMessageImages, BotMessageList, BotChatMessage, BotPermissionCard, BotRevertButton } from "@/components/bot/BotMessageList";
import { type ComposerAttachment, type ComposerReference } from "@/components/Composer";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { stabilizeIdentifiedList } from "@/lib/stabilize-messages";
import { cancelPendingSseReconnect, closeSseSource, sseReconnectDelayMs } from "@/lib/sse-reconnect";

import { CodeRequestCard } from "@/components/bot/CodeRequestCard";

function applyRoomSnapshot(current: RoomDto | null, next: RoomDto): RoomDto {
  if (!current || current.id !== next.id) return next;
  const messages = stabilizeIdentifiedList(current.messages, next.messages);
  return messages === next.messages ? next : { ...next, messages };
}

type MentionContext = { start: number; end: number; query: string };

const HANDOFF_STATE_TEXT: Record<RoomHandoffState, string> = {
  waiting: "Code完了待ち",
  ready: "実行待ち",
  running: "実行中",
  done: "完了",
  failed: "中断",
  cancelled: "取消",
};

function codeRequests(message: RoomMessage) {
  return message.codeRequests ?? (message.codeState ? [{ id: message.codeRequestId, taskId: message.codeTaskId, state: message.codeState, activity: message.codeActivity }] : []);
}
function isMessageBusy(message: RoomMessage): boolean {
  return message.status === "working" || codeRequests(message).some((request) => request.state !== "delivered" && request.state !== "cancelled");
}

/** All outstanding Code requests count, even when another request in the same message has finished. */
function isRoomBusy(room: RoomDto | null): boolean {
  return (room?.messages ?? []).some(isMessageBusy)
    || (room?.handoffs ?? []).some((handoff) => handoff.state === "ready" || handoff.state === "running");
}

type MentionCandidate = { key: string; value: string; label: string; description: string; bot?: BotDto };

const SPECIAL_MENTIONS: MentionCandidate[] = [
  { key: "special:here", value: "here", label: "@here", description: "全員にメンション" },
  { key: "special:channel", value: "channel", label: "@channel", description: "全員にメンション" },
];

const OUTCOME_TEXT: Record<string, string> = {
  "code-wait": "Codeの結果を待っています",
  members: "会話できるメンバーが足りません",
  turns: "発言上限に達しました",
  repeat: "同じ内容が繰り返されたため停止しました",
  done: "会話は完了しました",
};

function mentionContextFor(value: string, cursor: number): MentionContext | null {
  const start = value.lastIndexOf("@", cursor - 1);
  if (start < 0 || (start > 0 && !/\s/.test(value[start - 1] ?? ""))) return null;
  const query = value.slice(start + 1, cursor);
  return /^[^\s@]*$/.test(query) ? { start, end: cursor, query } : null;
}

export function RoomView({ id, active = true }: { id: string; active?: boolean }) {
  const [room, setRoom] = useState<RoomDto | null>(null);
  const [bots, setBots] = useState<BotDto[]>([]);
  const [skills, setSkills] = useState<ComposerReference[]>([]);
  const [attention, setAttention] = useState<RoomAttention[]>([]);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const [stoppingCode, setStoppingCode] = useState<string[]>([]);
  const [reverting, setReverting] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [prompt, setPrompt] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [memberSaving, setMemberSaving] = useState(false);
  const [approveSaving, setApproveSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionContext, setMentionContext] = useState<MentionContext | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const composingRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  const load = useCallback((isCurrent: () => boolean) => {
    return Promise.all([
      getJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`),
      getJson<{ bots: BotDto[] }>("/api/bots"),
    ])
      .then(([roomResult, botResult]) => {
        if (!isCurrent()) return;
        setRoom(roomResult.room);
        setBots(botResult.bots);
      })
      .catch((reason) => {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : "読み込みに失敗しました");
      });
  }, [id]);

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => { current = false; };
  }, [load]);

  // Drop the previous room immediately; load/SSE refill for the new id.
  useEffect(() => {
    setRoom(null);
    setAttention([]);
    setAttentionBusy(null);
    setError(null);
    setPrompt("");
    setAttachments([]);
    setBusy(false);
    setBroadcast(false);
    setMentionContext(null);
    setSettingsOpen(false);
  }, [id]);

  useEffect(() => {
    let closed = false;
    setSkills([]);
    void getJson<{ skills?: SkillDto[] }>("/api/skills")
      .then((result) => {
        if (closed) return;
        setSkills((result.skills ?? []).filter((skill) => skill.botEnabled ?? skill.enabled).map(({ name, description }) => ({ name, description })));
      })
      .catch(() => {
        // Skill discovery is optional; the Room remains usable when it is unavailable.
      });
    return () => { closed = true; };
  }, [id]);

  useEffect(() => {
    const latest = room?.messages.reduce((value, message) => Math.max(value, message.createdAt), 0) ?? 0;
    if (active && latest > 0) markRead("room", id, latest);
  }, [active, id, room?.messages]);

  // A room that finishes answering while you are on another tab should still reach you.
  const prevAttentionRef = useRef(false);
  const prevWorkingRef = useRef(false);
  useEffect(() => {
    if (typeof Notification === "undefined" || !room) return;
    const busyNow = isRoomBusy(room);
    const attentionNow = attention.length > 0;
    // A room notification is still governed by the per-Bot toggle: only members that can actually
    // answer decide it, so a disabled or removed Bot cannot keep a muted room loud.
    const anyMemberNotifies = room.members.some((memberId) => {
      const member = bots.find((bot) => bot.id === memberId);
      return member ? member.enabled !== false && member.notificationsEnabled !== false : false;
    });
    const kind = decideNotification({
      prevAttention: prevAttentionRef.current, attention: attentionNow,
      prevWorking: prevWorkingRef.current, working: busyNow,
      documentHidden: typeof document !== "undefined" && document.hidden,
      permission: Notification.permission,
    });
    prevAttentionRef.current = attentionNow;
    prevWorkingRef.current = busyNow;
    // One notification per room replaces the previous one instead of stacking.
    if (kind && anyMemberNotifies) new Notification(kind === "attention" ? "承認が必要です" : "新しい返信があります", { body: room.name, tag: `room-${id}` });
  }, [attention, bots, id, room]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    setAttention([]);
    const connect = () => {
      if (closed) return;
      retry = cancelPendingSseReconnect(retry);
      source = closeSseSource(source);
      source = new EventSource(`/api/bots/rooms/${encodeURIComponent(id)}/events?epoch=${Date.now()}`);
      source.addEventListener("snapshot", (event) => {
        if (closed) return;
        retryCount = 0;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { room?: RoomDto; attention?: RoomAttention[] };
          if (payload.room) setRoom((current) => applyRoomSnapshot(current, payload.room!));
          setAttention((current) => {
            const next = payload.attention ?? [];
            if (
              current.length === next.length
              && current.every((item, index) => {
                const other = next[index];
                return other
                  && item.taskId === other.taskId
                  && item.botId === other.botId
                  && item.permission?.id === other.permission?.id
                  && item.question?.id === other.question?.id;
              })
            ) {
              return current;
            }
            return next;
          });
        } catch { setError("イベントの解析に失敗しました"); }
      });
      source.onerror = () => {
        if (closed) return;
        source = closeSseSource(source);
        retry = cancelPendingSseReconnect(retry);
        retryCount += 1;
        retry = setTimeout(connect, sseReconnectDelayMs(retryCount));
      };
    };
    connect();
    return () => {
      closed = true;
      retry = cancelPendingSseReconnect(retry);
      source = closeSseSource(source);
    };
  }, [id]);

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const members = useMemo(
    () => (room ? room.members.map((memberId) => botById.get(memberId)).filter((bot): bot is BotDto => Boolean(bot)) : []),
    [botById, room],
  );
  const busyIds = useMemo(() => new Set((room?.messages ?? []).flatMap((message) => {
    const working = isMessageBusy(message);
    return working && message.botId ? [message.botId] : [];
  })), [room?.messages]);
  const attentionIds = useMemo(() => new Set(attention.map((item) => item.botId)), [attention]);
  const mentionCandidates = useMemo(() => {
    if (!mentionContext) return [];
    const query = mentionContext.query.toLocaleLowerCase();
    const botCandidates = members
      .filter((bot) => bot.enabled)
      .map((bot): MentionCandidate => ({ key: `bot:${bot.id}`, value: bot.name, label: `@${bot.name}`, description: "Botにメンション", bot }));
    return [...SPECIAL_MENTIONS, ...botCandidates].filter((candidate) => !query || candidate.value.toLocaleLowerCase().includes(query));
  }, [members, mentionContext]);

  useEffect(() => { setMentionIndex(0); }, [mentionContext?.query]);

  const saveAutoApprove = async (value: boolean) => {
    if (!room || approveSaving) return;
    setApproveSaving(true);
    setError(null);
    try {
      const result = await sendJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`, { codeAutoApprove: value }, "PATCH");
      setRoom(result.room);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "設定の保存に失敗しました");
    } finally { setApproveSaving(false); }
  };

  const saveMembers = async (next: string[]) => {
    if (!room || memberSaving) return;
    setMemberSaving(true);
    setError(null);
    try {
      const result = await sendJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`, { members: next }, "PATCH");
      setRoom(result.room);
      notifyBotSidebarChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30e1\u30f3\u30d0\u30fc\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
    finally { setMemberSaving(false); }
  };

  const resetConversation = async () => {
    if (!room || resetting || !window.confirm(`「${room.name}」の会話をリセットしますか？\nこの操作は取り消せません。`)) return;
    setResetting(true);
    setError(null);
    try {
      const result = await sendJson<{ room: RoomDto }>(`/api/bots/rooms/${encodeURIComponent(id)}`, { resetMessages: true }, "PATCH");
      setRoom(result.room);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会話のリセットに失敗しました");
    } finally {
      setResetting(false);
    }
  };

  const removeRoom = async () => {
    if (!room || deleting || !window.confirm(`「${room.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await sendJson(`/api/bots/rooms/${encodeURIComponent(id)}`, undefined, "DELETE");
      notifyBotSidebarChanged();
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
      if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]!);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composingRef.current) {
      event.preventDefault();
      void send();
    }
  };

  const addImageFiles = useCallback((files: FileList) => {
    if (!canAttachComposerImages({ submitting: busy })) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => setAttachments((current) => [...current, { uri: String(reader.result), mime: file.type, name: file.name }]);
      reader.readAsDataURL(file);
    });
  }, [busy]);

  const send = async () => {
    const value = prompt.trim();
    if ((!value && attachments.length === 0) || busy) return;
    const images = attachments.flatMap((attachment) => {
      const comma = attachment.uri.indexOf(",");
      return comma < 0 ? [] : [{ mimeType: attachment.mime, data: attachment.uri.slice(comma + 1) }];
    });
    setPrompt("");
    setAttachments([]);
    setMentionContext(null);
    setError(null);
    setBusy(true);
    try {
      const result = await sendJson<{ room: RoomDto; routedBotIds?: string[]; steeredBotIds?: string[]; stopped?: boolean }>(
        `/api/bots/rooms/${encodeURIComponent(id)}/prompt`,
        { prompt: value, broadcast, ...(images.length > 0 ? { images } : {}) },
      );
      if (result.room) {
        setRoom(result.room);
        notifyBotSidebarChanged();
      }
      // Redirecting a turn already being written is a real outcome, even with nobody newly routed.
      if (!result.stopped && result.routedBotIds?.length === 0 && !result.steeredBotIds?.length) {
        setError("応答できるボットがいません。有効なメンバーとメンション先を確認してください。");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "リクエストに失敗しました"); }
    finally { setBusy(false); }
  };

  const respond = async (item: RoomAttention, approved: boolean) => {
    if (!item.permission || attentionBusy) return;
    const requestId = item.permission.id;
    setAttentionBusy(requestId);
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(item.taskId)}/permission`, { requestId, approved });
      setAttention((current) => current.map((entry) => entry.permission?.id === requestId ? { ...entry, permission: null } : entry));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "権限リクエストに失敗しました"); }
    finally { setAttentionBusy(null); }
  };
  const answerQuestion = async (taskId: string, request: QuestionRequestDto, answers?: string[][]) => {
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(taskId)}/question`, { requestId: request.id, ...(answers ? { answers } : { reject: true }) });
      setAttention((current) => current.map((entry) => entry.question?.id === request.id ? { ...entry, question: null } : entry));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "質問への回答に失敗しました");
    }
  };

  const stopCode = useCallback(async (requestId?: string) => {
    const key = requestId ?? "legacy";
    if (stoppingCode.includes(key)) return;
    setStoppingCode((current) => [...current, key]);
    setError(null);
    try { await sendJson(`/api/bots/rooms/${encodeURIComponent(id)}/code`, { action: "abort", ...(requestId ? { requestId } : {}) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Codeの停止に失敗しました"); }
    finally { setStoppingCode((current) => current.filter((item) => item !== key)); }
  }, [id, stoppingCode]);

  const revertMessage = useCallback(async (messageId: string) => {
    if (reverting) return;
    setReverting(true);
    setError(null);
    try {
      const result = await sendJson<{ room: RoomDto; text: string }>(`/api/bots/rooms/${encodeURIComponent(id)}/revert`, { messageId });
      setRoom(result.room);
      setPrompt(result.text);
      requestAnimationFrame(() => promptRef.current?.focus());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "巻き戻しに失敗しました"); }
    finally { setReverting(false); }
  }, [id, reverting]);

  const rendered = useMemo(() => (room?.messages ?? []).map((message) => {
    const user = message.role === "user";
    const bot = message.botId ? botById.get(message.botId) : undefined;
    const text = message.text || (message.status === "working" ? "応答中…" : "");
    const requests = codeRequests(message);
    if (!text && !requests.length && !message.images?.length && !message.handoffs?.length) return null;
    return (
      <BotChatMessage key={message.id} user={user} createdAt={message.createdAt}
        sender={{ ...bot, name: bot?.name ?? message.botName ?? "ボット", active: message.status === "working" }} text={text} mentions={bots}
        images={<BotMessageImages images={(message.images ?? []).map((image) => ({ key: image.file, src: `/api/bots/rooms/${encodeURIComponent(id)}/images/${encodeURIComponent(image.file)}` }))} />}
        footer={user ? <BotRevertButton title="この発言以降を入力欄に戻して巻き戻す" disabled={reverting} onClick={() => void revertMessage(message.id)} /> : undefined}>
        {requests.map((request) => <CodeRequestCard key={request.id ?? "legacy"} {...request} stopping={stoppingCode.includes(request.id ?? "legacy")} onStop={() => void stopCode(request.id)} />)}
        {message.handoffs?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {message.handoffs.map((handoff) => (
              <span key={handoff.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                <span aria-hidden="true">→</span>{`@${handoff.toBotName} ${HANDOFF_STATE_TEXT[handoff.state]}`}
              </span>
            ))}
          </div>
        ) : null}
        {message.status === "error" && <BotMessageError text="応答に失敗しました" />}
      </BotChatMessage>
    );
  }), [botById, bots, id, room?.messages, revertMessage, reverting, stopCode, stoppingCode]);

  const working = isRoomBusy(room);
  const latestRequestId = room?.messages.findLast((message) => message.role === "user")?.id;
  // Persisted rooms may still carry a wait outcome from before result delivery.
  const delivered = Boolean(room?.messages.some((message) => message.codeState === "delivered" && message.conversation?.requestId === latestRequestId));
  const outcome = room && !working && room.lastOutcome && room.lastOutcome.requestId === latestRequestId
    ? OUTCOME_TEXT[room.lastOutcome.kind === "code-wait" && delivered ? "done" : room.lastOutcome.kind] : undefined;
  // Fingerprint attention separately so identical SSE payloads keep a stable contentKey object.
  const attentionScrollKey = attention
    .map((item) => `${item.taskId}:${item.permission?.id ?? ""}:${item.question?.id ?? ""}`)
    .join("|");
  const chatScrollKey = useMemo(() => ({
    messages: room?.messages,
    attention: attentionScrollKey,
    working,
    outcome: outcome ?? "",
  }), [room?.messages, attentionScrollKey, working, outcome]);

  if (!room) return <div className="p-5 text-sm text-muted">{error ?? "読み込み中…"}</div>;

  return (
    <div className="flex h-full min-h-0 bg-bot-chat">
      <div className={`${settingsOpen ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
      <BotChatHeader
        title={room.name}
        subtitle={attentionIds.size > 0
          ? `${members.filter((member) => attentionIds.has(member.id)).map((member) => member.name).join("、")} が確認待ち`
          : busyIds.size > 0
            ? `${members.filter((member) => busyIds.has(member.id)).map((member) => member.name).join("、")} が応答中…`
            : `ルーム・${room.members.length} 人`}
        members={members.map((member) => ({ ...member, active: busyIds.has(member.id), attention: attentionIds.has(member.id) }))}
        active={working}
        settingsOpen={settingsOpen}
        onSettings={() => setSettingsOpen((open) => !open)}
      />


      <BotMessageList conversationId={id} contentKey={chatScrollKey}>
        <div className={conversationContentClass}>
          {room.messages.length === 0 && <BotEmptyState icon={<Users className="h-5 w-5" />} title={room.name + " \u3067\u8a71\u3059"} description="そのまま送るとメンバーが会話します。@ボット名で相手を指定、@hereで全員に個別回答を依頼できます。実作業は承認後にCodeで実行し、このRoomへ結果を返します。">{members.length > 0 && <div className="mt-3 flex flex-wrap justify-center gap-2">{members.map((bot) => <span key={bot.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-xs"><BotAvatar size={18} {...bot} />{bot.name}</span>)}</div>}</BotEmptyState>}
          {rendered}
          {attention.map((item) => <div key={item.taskId} className="space-y-3">
            {item.permission && <BotPermissionCard
              label={`${botById.get(item.botId)?.name ?? "Bot"}の権限確認`}
              title={`${botById.get(item.botId)?.name ?? "Bot"}：権限の確認が必要です`}
              message={item.permission.message}
              command={item.permission.command}
              disabled={Boolean(attentionBusy)}
              onAllow={() => void respond(item, true)}
              onDeny={() => void respond(item, false)}
            />}
            {item.question && <div><p className="mb-1 text-xs text-muted">{botById.get(item.botId)?.name ?? "Bot"}からの質問</p><QuestionCard request={item.question} onReply={(request, answers) => answerQuestion(item.taskId, request, answers)} onReject={(request) => answerQuestion(item.taskId, request)} /></div>}
          </div>)}
          {working && <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />応答中…</div>}
          {outcome && <p className="text-xs text-muted">{outcome}</p>}
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
        placeholder={broadcast ? `${room.name}の全員に個別回答を依頼（Ctrl+Enterで送信、Enterで改行）` : `${room.name}にメッセージ（@で相手、/でスキル、Ctrl+Enterで送信、Enterで改行）`}
        sendDisabled={!prompt.trim() && attachments.length === 0}
        busy={busy}
        onSend={() => void send()}
        references={{ skills }}
        onValueChange={setPrompt}
        attachments={attachments}
        onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, position) => position !== index))}
        onPaste={(event) => { if (pasteImage(addImageFiles, event)) event.preventDefault(); }}
        footer={<><button type="button" aria-pressed={broadcast} onClick={() => setBroadcast((value) => !value)} className={`rounded-full px-2 py-1 font-medium ${broadcast ? "bg-accent/10 text-accent" : "hover:bg-surface-2 hover:text-text"}`}>{broadcast ? "全員が個別回答" : "メンバーで対話"}</button><button type="button" onClick={() => setSettingsOpen(true)} className="shrink-0 hover:text-text">{`\u30e1\u30f3\u30d0\u30fc: ${room.members.length}`}</button></>}
        inputOverlay={mentionCandidates.length > 0 ? <div id="room-mention-options" role="listbox" aria-label={"\u30e1\u30f3\u30b7\u30e7\u30f3\u5148\u5019\u88dc"} className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">{mentionCandidates.map((candidate, index) => <button key={candidate.key} type="button" role="option" aria-selected={index === mentionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(candidate)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${index === mentionIndex ? "bg-surface-2" : "hover:bg-surface-2"}`}>{candidate.bot ? <BotAvatar size={24} {...candidate.bot} /> : <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">@</span>}<span className="min-w-0"><span className="block truncate text-sm font-medium">{candidate.label}</span><span className="block truncate text-[11px] text-muted">{candidate.description}</span></span></button>)}</div> : null}
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
                    <BotAvatar size={24} {...bot} />
                    <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                  </label>
                ))}
                {bots.length === 0 && <p className="px-2 py-2 text-xs text-muted">ボットがありません</p>}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-bg p-4">
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5" disabled={approveSaving} checked={room.codeAutoApprove === true} onChange={(event) => void saveAutoApprove(event.target.checked)} />
                <span className="min-w-0">
                  <span className="block font-medium">Codeを毎回承認せずに実行</span>
                  <span className="mt-1 block text-xs text-muted">このルームの依頼だけ、承認ダイアログを省略します。Bot自身は変更できません。</span>
                </span>
              </label>
            </div>
            <div className="rounded-2xl border border-border bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <div><span className="text-sm font-medium">全員が個別回答</span><p className="mt-0.5 text-xs text-muted">オフでは相手の返答を読んで対話し、オンでは各メンバーが独立して回答します。対話の後続停止は /stop（実行中のCodeは継続）。</p></div>
                <Button size="sm" variant={broadcast ? "primary" : "ghost"} onClick={() => setBroadcast((value) => !value)} aria-pressed={broadcast}>{broadcast ? "一斉回答" : "対話"}</Button>
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-bg p-4">
              <p className="text-sm font-medium">会話リセット</p>
              <p className="mt-1 text-xs text-muted">このルームの会話をクリアして、新しい会話を開始します。ルーム自体は残ります。</p>
              <Button size="sm" variant="ghost" onClick={() => void resetConversation()} busy={resetting} className="mt-2">会話をリセット</Button>
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
