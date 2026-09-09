"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, X } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import { notifyBotSidebarChanged } from "@/lib/events";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { Button } from "@/components/ui";
import { BotAvatarPicker, type AvatarPatch } from "@/components/bot/BotAvatarPicker";
import { BotEmptyState } from "@/components/bot/BotEmptyState";
import { BotChatHeader } from "@/components/bot/BotChatHeader";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { BotComposer } from "@/components/bot/BotComposer";
import { ImageLightbox, type ComposerAttachment } from "@/components/Composer";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { BotMessageError, BotMessageList, BotMessageMarkdown, BotMessageRow, BotMessageSender, BotResponseStatus } from "@/components/bot/BotMessageList";
import { BotCodeSessionPanel } from "@/components/bot/BotCodeSessionPanel";
import { BotCodeRequests } from "@/components/bot/BotCodeRequests";
import { QuestionCard } from "@/components/task/QuestionCard";
import { markRead } from "@/lib/bot-unread";
import type { BotDto, ModelOption, PermissionRequestDto, QuestionRequestDto, RoutineDto, ThinkingLevel, UiMessage } from "@/lib/types";

function textOf(message: UiMessage): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
}

const BOT_AUTO_SAVE_DELAY_MS = 600;
const BOT_SETTINGS_OPEN_KEY_PREFIX = "webui:bot-settings-open:";

function readBotSettingsOpen(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${BOT_SETTINGS_OPEN_KEY_PREFIX}${id}`) === "1";
  } catch {
    return false;
  }
}

function saveBotSettingsOpen(id: string, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${BOT_SETTINGS_OPEN_KEY_PREFIX}${id}`, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function BotView({ id, active = true }: { id: string; active?: boolean }) {
  const [bot, setBot] = useState<BotDto | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [permission, setPermission] = useState<PermissionRequestDto | null>(null);
  const [question, setQuestion] = useState<QuestionRequestDto | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [soul, setSoul] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileLabel, setProfileLabel] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [codeAutoApprove, setCodeAutoApprove] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  const [sending, setSending] = useState(false);
  const { reportStatus } = useTaskPanes();
  useEffect(() => {
    reportStatus(`/bots/${encodeURIComponent(id)}`, sending ? "working" : "idle");
  }, [id, sending, reportStatus]);
  const [reverting, setReverting] = useState(false);
  const [savingSoul, setSavingSoul] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [updatingThinking, setUpdatingThinking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingSkills, setUpdatingSkills] = useState(false);
  const [extraRootInput, setExtraRootInput] = useState("");
  const [routines, setRoutines] = useState<RoutineDto[]>([]);
  const [routineFormOpen, setRoutineFormOpen] = useState(false);
  const [routineCardOpen, setRoutineCardOpen] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [routineSchedule, setRoutineSchedule] = useState("0 * * * *");
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [routineBusy, setRoutineBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const profileSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soulSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileDraftRef = useRef({ name: "", label: "" });
  const soulDraftRef = useRef("");
  const autoSaveQueueRef = useRef(Promise.resolve());
  const router = useRouter();
  const applyBotUpdate = (next: BotDto) => {
    setBot(next);
    notifyBotSidebarChanged();
  };

  const load = useCallback(() => {
    return getJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`)
      .then((result) => {
        profileDraftRef.current = { name: result.bot.name, label: result.bot.label };
        soulDraftRef.current = result.bot.soul;
        setBot(result.bot);
        setSoul(result.bot.soul);
        setProfileName(result.bot.name);
        setProfileLabel(result.bot.label);
        setNotificationsEnabled(result.bot.notificationsEnabled);
        setCodeAutoApprove(result.bot.codeAutoApprove === true);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました"));
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const saved = readBotSettingsOpen(id);
    settingsOpenRef.current = saved;
    setSettingsOpen(saved);
  }, [id]);
  const updateSettingsOpen = (open: boolean) => {
    settingsOpenRef.current = open;
    setSettingsOpen(open);
    saveBotSettingsOpen(id, open);
  };
  const toggleSettings = () => updateSettingsOpen(!settingsOpenRef.current);
  useEffect(() => {
    const latest = messages.reduce((value, message) => Math.max(value, message.createdAt), 0);
    if (active && latest > 0) markRead("bot", id, latest);
  }, [active, id, messages]);
  const loadRoutines = useCallback(() => getJson<{ routines: RoutineDto[] }>(`/api/bots/${encodeURIComponent(id)}/routines`).then((result) => setRoutines(result.routines)).catch((reason) => setError(reason instanceof Error ? reason.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u3092\u8aad\u307f\u8fbc\u3081\u307e\u305b\u3093\u3067\u3057\u305f")), [id]);
  useEffect(() => { void loadRoutines(); }, [loadRoutines]);

  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    void getJson<{ models: ModelOption[] }>("/api/models")
      .then((result) => { if (active) setModels(result.models); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "モデルを読み込めませんでした"); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      source?.close();
      source = new EventSource(`/api/bots/${encodeURIComponent(id)}/events?epoch=${Date.now()}`);
      source.addEventListener("snapshot", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            messages?: UiMessage[];
            isStreaming?: boolean;
            error?: string;
            permissionRequest?: PermissionRequestDto | null;
            questionRequest?: QuestionRequestDto | null;
          };
          if (payload.messages) setMessages(payload.messages);
          setPermission(payload.permissionRequest ?? null);
          setQuestion(payload.questionRequest ?? null);
          setSending(Boolean(payload.isStreaming));
          if (payload.error) setError(payload.error);
        } catch { setError("イベントの解析に失敗しました"); }
      });
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [id]);

  const selectedModel = useMemo(
    () => modelOptionForValue(models, bot?.model) ?? models[0],
    [bot?.model, models],
  );
  const modelValue = selectedModel?.value ?? bot?.model ?? "";
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const thinkingValue: ThinkingLevel = bot?.thinkingLevel && thinkingLevels.includes(bot.thinkingLevel)
    ? bot.thinkingLevel
    : (thinkingLevels[0] ?? "off");

  const addImageFiles = (files: FileList) => {
    if (!canAttachComposerImages({ submitting: sending })) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => setAttachments((current) => [...current, { uri: String(reader.result), mime: file.type, name: file.name }]);
      reader.readAsDataURL(file);
    });
  };

  const send = async () => {
    const value = prompt.trim();
    if ((!value && attachments.length === 0) || sending) return;
    const images = attachments.map((attachment) => {
      const comma = attachment.uri.indexOf(",");
      return comma < 0 ? null : { mimeType: attachment.mime, data: attachment.uri.slice(comma + 1) };
    }).filter((image): image is { mimeType: string; data: string } => image !== null);
    setPrompt("");
    setAttachments([]);
    setError(null);
    setSending(true);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(id)}/prompt`, { prompt: value, ...(images.length > 0 ? { images } : {}) });
      notifyBotSidebarChanged();
    } catch (reason) {
      setSending(false);
      setError(reason instanceof Error ? reason.message : "リクエストに失敗しました");
    }
  };

  const revertMessage = async (message: UiMessage) => {
    if (reverting || sending || message.role !== "user") return;
    setReverting(true);
    setError(null);
    try {
      const result = await sendJson<{ text: string; images: ComposerAttachment[] }>(
        `/api/bots/${encodeURIComponent(id)}/revert`,
        { entryId: message.id },
      );
      setPrompt(result.text);
      setAttachments(result.images ?? []);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "巻き戻しに失敗しました");
    } finally {
      setReverting(false);
    }
  };

  const respond = async (approved: boolean) => {
    if (!permission) return;
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(`bot:${id}`)}/permission`, { requestId: permission.id, approved });
      setPermission((current) => current?.id === permission.id ? null : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "権限リクエストに失敗しました"); }
  };

  const answerQuestion = async (request: QuestionRequestDto, answers?: string[][]) => {
    await sendJson(`/api/tasks/${encodeURIComponent(`bot:${id}`)}/question`, { requestId: request.id, ...(answers ? { answers } : { reject: true }) });
    setQuestion((current) => current?.id === request.id ? null : current);
  };

  const abort = async () => {
    try { await sendJson(`/api/bots/${encodeURIComponent(id)}/abort`, {}); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "リクエストに失敗しました"); }
  };

  const updateNotifications = async (value: boolean) => {
    const previous = notificationsEnabled;
    setNotificationsEnabled(value);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { notificationsEnabled: value }, "PATCH");
      applyBotUpdate(result.bot);
      setNotificationsEnabled(result.bot.notificationsEnabled);
    } catch (reason) {
      setNotificationsEnabled(previous);
      setError(reason instanceof Error ? reason.message : "\u901a\u77e5\u8a2d\u5b9a\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f");
    }
  };

  const updateCodeAutoApprove = async (value: boolean) => {
    const previous = codeAutoApprove;
    setCodeAutoApprove(value);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { codeAutoApprove: value }, "PATCH");
      applyBotUpdate(result.bot);
      setCodeAutoApprove(result.bot.codeAutoApprove === true);
    } catch (reason) {
      setCodeAutoApprove(previous);
      setError(reason instanceof Error ? reason.message : "Code設定の保存に失敗しました");
    }
  };

  const updateModel = async (value: string) => {
    if (!value || value === modelValue) return;
    setUpdatingModel(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { model: value }, "PATCH");
      applyBotUpdate(result.bot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "モデルの切替に失敗しました");
    } finally { setUpdatingModel(false); }
  };

  const updateThinking = async (value: ThinkingLevel) => {
    if (value === bot?.thinkingLevel) return;
    setUpdatingThinking(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { thinkingLevel: value }, "PATCH");
      applyBotUpdate(result.bot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "思考レベルの切替に失敗しました");
    } finally { setUpdatingThinking(false); }
  };

  const updateAvatar = async (patch: AvatarPatch) => {
    if (!bot) return;
    const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(bot.id)}`, patch, "PATCH");
    setBot((current) => current?.id === result.bot.id ? {
      ...current, avatarColor: result.bot.avatarColor, avatarShape: result.bot.avatarShape, avatarImage: result.bot.avatarImage,
      avatarEyeColor: result.bot.avatarEyeColor, avatarGlasses: result.bot.avatarGlasses, avatarMustache: result.bot.avatarMustache,
    } : current);
    notifyBotSidebarChanged();
  };

  const saveProfile = async (nextName: string, nextLabel: string) => {
    const name = nextName.trim();
    const label = nextLabel.trim();
    if (!name || !label) return;
    setSavingProfile(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { name, label }, "PATCH");
      applyBotUpdate(result.bot);
      if (profileDraftRef.current.name === nextName && profileDraftRef.current.label === nextLabel) {
        setProfileName(result.bot.name);
        setProfileLabel(result.bot.label);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "プロフィールの保存に失敗しました");
    } finally { setSavingProfile(false); }
  };

  const saveSoul = async (nextSoul: string) => {
    setSavingSoul(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { soul: nextSoul }, "PATCH");
      applyBotUpdate(result.bot);
      if (soulDraftRef.current === nextSoul) setSoul(result.bot.soul);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "説明の自動保存に失敗しました"); }
    finally { setSavingSoul(false); }
  };

  const scheduleProfileSave = (nextName: string, nextLabel: string) => {
    profileDraftRef.current = { name: nextName, label: nextLabel };
    if (profileSaveTimerRef.current !== null) clearTimeout(profileSaveTimerRef.current);
    profileSaveTimerRef.current = setTimeout(() => {
      profileSaveTimerRef.current = null;
      autoSaveQueueRef.current = autoSaveQueueRef.current.then(() => saveProfile(nextName, nextLabel));
    }, BOT_AUTO_SAVE_DELAY_MS);
  };

  const scheduleSoulSave = (nextSoul: string) => {
    soulDraftRef.current = nextSoul;
    if (soulSaveTimerRef.current !== null) clearTimeout(soulSaveTimerRef.current);
    soulSaveTimerRef.current = setTimeout(() => {
      soulSaveTimerRef.current = null;
      autoSaveQueueRef.current = autoSaveQueueRef.current.then(() => saveSoul(nextSoul));
    }, BOT_AUTO_SAVE_DELAY_MS);
  };

  const createRoutine = async () => {
    if (!routineName.trim() || !routinePrompt.trim() || !routineSchedule.trim()) return;
    setCreatingRoutine(true); setError(null);
    try { await sendJson(`/api/bots/${encodeURIComponent(id)}/routines`, { name: routineName, prompt: routinePrompt, schedule: routineSchedule }, "POST"); setRoutineName(""); setRoutinePrompt(""); setRoutineSchedule("0 * * * *"); setRoutineFormOpen(false); setRoutineCardOpen(false); await loadRoutines(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u4f5c\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); } finally { setCreatingRoutine(false); }
  };
  const updateSkills = async (skills: BotDto["skills"]) => {
    setUpdatingSkills(true); setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { skills }, "PATCH");
      applyBotUpdate(result.bot);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30b9\u30ad\u30eb\u8a2d\u5b9a\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
    finally { setUpdatingSkills(false); }
  };
  const addExtraRoot = async () => {
    const root = extraRootInput.trim();
    if (!root || !bot || bot.extraRoots.includes(root)) return;
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { extraRoots: [...bot.extraRoots, root] }, "PATCH");
      applyBotUpdate(result.bot); setExtraRootInput("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "\u8ffd\u52a0\u30eb\u30fc\u30c8\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
  };
  const removeExtraRoot = async (root: string) => {
    if (!bot) return;
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { extraRoots: bot.extraRoots.filter((item) => item !== root) }, "PATCH");
      applyBotUpdate(result.bot);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "\u8ffd\u52a0\u30eb\u30fc\u30c8\u306e\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
  };
  const patchRoutine = async (routine: RoutineDto, enabled: boolean) => { setRoutineBusy(routine.id); setError(null); try { await sendJson(`/api/bots/${encodeURIComponent(id)}/routines/${encodeURIComponent(routine.id)}`, { enabled }, "PATCH"); await loadRoutines(); } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u66f4\u65b0\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); } finally { setRoutineBusy(null); } };
  const deleteRoutine = async (routine: RoutineDto) => { if (!window.confirm(`「${routine.name}」を削除しますか？`)) return; setRoutineBusy(routine.id); setError(null); try { await sendJson(`/api/bots/${encodeURIComponent(id)}/routines/${encodeURIComponent(routine.id)}`, undefined, "DELETE"); await loadRoutines(); } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); } finally { setRoutineBusy(null); } };
  const runRoutine = async (routine: RoutineDto) => { setRoutineBusy(routine.id); setError(null); try { await sendJson(`/api/bots/${encodeURIComponent(id)}/routines/${encodeURIComponent(routine.id)}/run`, {}, "POST"); await loadRoutines(); } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u5b9f\u884c\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); } finally { setRoutineBusy(null); } };

  const resetConversation = async () => {
    if (!bot || resetting || !window.confirm(`「${bot.name}」の会話をリセットしますか？\nこの操作は取り消せません。`)) return;
    setResetting(true);
    setError(null);
    try {
      await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { resetMessages: true }, "PATCH");
      setMessages([]);
      setPermission(null);
      setQuestion(null);
      setSending(false);
      notifyBotSidebarChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会話のリセットに失敗しました");
    } finally {
      setResetting(false);
    }
  };

  const removeBot = async () => {
    if (!bot || deleting || !window.confirm(`「${bot.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(id)}`, undefined, "DELETE");
      notifyBotSidebarChanged();
      router.push("/bots");
    } catch (reason) {
      setDeleting(false);
      setError(reason instanceof Error ? reason.message : "ボットの削除に失敗しました");
    }
  };

  const rendered = useMemo(() => {
    return messages.map((message) => {
    const user = message.role === "user";
    const text = textOf(message);
    const images = message.parts.filter((part) => part.type === "image");
    const requestIds = message.role === "assistant" ? message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "code_session" || !part.state.output) return [];
      try {
        const result = JSON.parse(part.state.output);
        return typeof result?.requestId === "string" ? [result.requestId] : [];
      } catch { return []; }
    }) : [];
    if (!text && images.length === 0 && !message.error && requestIds.length === 0) return null;
    return (
      <BotMessageRow key={message.id} user={user} createdAt={message.createdAt} timeInHeader={!user}
        header={user ? undefined : <BotMessageSender {...(bot ?? {})} name={bot?.name ?? "ボット"} createdAt={message.createdAt} />}
        footer={user ? <button type="button" title="このコメントを入力欄に戻して巻き戻す" disabled={reverting || sending} onClick={() => void revertMessage(message)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-muted active:bg-surface-3 active:text-text disabled:opacity-40 touch-manipulation"><RotateCcw className="h-3 w-3" />入力欄に戻す</button> : undefined}>
        {images.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{images.map((part) => part.type === "image" && <ImageLightbox key={part.id} src={part.url} alt={part.filename ?? "添付画像"} className="max-h-48 max-w-full rounded-xl object-contain" />)}</div>}
        {text && (user ? <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</div> : <BotMessageMarkdown text={text} />)}
        {message.error && <BotMessageError text={message.error} />}
        {requestIds.length > 0 && <BotCodeRequests botId={id} requestIds={requestIds} />}
      </BotMessageRow>
    );
    });
  }, [bot, id, messages, reverting, sending]);

  if (!bot) return <div className="p-5 text-sm text-muted">{error ?? "読み込み中…"}</div>;

  return (
    <div className="flex h-full min-h-0 bg-bot-chat">
      <div className={`${settingsOpen ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
      <BotChatHeader
        title={bot.name}
        subtitle={"\u4e00\u5bfe\u4e00 \u30dc\u30c3\u30c8"}
        bot={bot}
        settingsOpen={settingsOpen}
        active={sending}
        onSettings={toggleSettings}
      />


      <BotMessageList conversationId={id}>
        <div className="mx-auto w-full space-y-4">
          {messages.length === 0 && !sending && <BotEmptyState avatar={bot} title={bot.name + " \u3068\u8a71\u3059"} description={"\u4e0b\u306e\u5165\u529b\u6b04\u304b\u3089\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u9001\u3063\u3066\u4f1a\u8a71\u3092\u59cb\u3081\u307e\u3057\u3087\u3046\u3002"} />}
          {routines.some((routine) => routine.failureCount > 0) && <div role="status" className="rounded-2xl border border-danger/40 bg-danger/5 p-4 text-sm"><p className="font-medium text-danger">{"\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u5b9f\u884c\u306b\u5931\u6557\u3057\u3066\u3044\u307e\u3059"}</p><div className="mt-2 space-y-1 text-xs text-muted">{routines.filter((routine) => routine.failureCount > 0).map((routine) => <p key={routine.id}><span className="font-medium text-text">{routine.name}</span>{"\uFF1A"}{"\u9023\u7d9a\u5931\u6557"} {routine.failureCount}{"\u56de"}{routine.enabled ? "" : "\u3002\u5b89\u5168\u306e\u305f\u3081\u81ea\u52d5\u7684\u306b\u7121\u52b9\u5316\u3057\u307e\u3057\u305f"}</p>)}</div></div>}
          {routineCardOpen && <div className="rounded-2xl border border-accent/40 bg-surface p-4 shadow-sm" role="dialog" aria-label="ルーティン作成の確認"><p className="font-medium text-accent">ルーティンを作成</p><p className="mt-1 text-xs text-muted">内容を確認してから保存します。</p><div className="mt-3 space-y-2"><input value={routineName} onChange={(event) => setRoutineName(event.target.value)} placeholder="名前（例: 朝の確認）" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" /><textarea value={routinePrompt} onChange={(event) => setRoutinePrompt(event.target.value)} placeholder="Bot に実行させる指示" rows={3} className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" /><input value={routineSchedule} onChange={(event) => setRoutineSchedule(event.target.value)} aria-label="cron スケジュール" placeholder="0 * * * *" className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent" /><p className="text-[11px] text-muted">形式: 分 時 日 月 曜日（最短間隔 5 分）</p></div><div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setRoutineCardOpen(false)}>キャンセル</Button><Button size="sm" onClick={() => void createRoutine()} busy={creatingRoutine} disabled={!routineName.trim() || !routinePrompt.trim() || !routineSchedule.trim()}>この内容で作成</Button></div></div>}
          {rendered}
          {permission && <div role="alertdialog" aria-label="権限の確認" className="rounded-2xl border border-warning/40 bg-warning-bg p-4 text-xs"><p className="font-medium">権限の確認が必要です</p><p className="mt-1 whitespace-pre-wrap break-all text-muted">{permission.message}</p><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-2">{permission.command}</pre><div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void respond(true)}>許可</Button><Button size="sm" variant="ghost" onClick={() => void respond(false)}>拒否</Button></div></div>}
          {question && <QuestionCard request={question} onReply={answerQuestion} onReject={(request) => answerQuestion(request)} />}
          {sending && <BotResponseStatus messages={messages} avatar={bot} />}
        </div>
      </BotMessageList>

      <BotComposer
        value={prompt}
        inputRef={inputRef}
        attachments={attachments}
        onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        onPaste={(event) => { if (pasteImage(addImageFiles, event)) event.preventDefault(); }}
        onChange={(event) => setPrompt(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composingRef.current) { event.preventDefault(); void send(); } }}
        placeholder={`${bot.name}\u306b\u30e1\u30c3\u30bb\u30fc\u30b8`}
        sendDisabled={!prompt.trim() && attachments.length === 0}
        busy={sending}
        onSend={() => void send()}
        onAbort={() => void abort()}
        footer={<><button type="button" onClick={() => setRoutineCardOpen(true)} className="shrink-0 font-medium text-accent hover:underline">{"\u30eb\u30fc\u30c6\u30a3\u30f3\u3092\u4f5c\u6210"}</button><button type="button" onClick={() => updateSettingsOpen(true)} className="truncate hover:text-text">{"\u30e2\u30c7\u30eb"}: {selectedModel?.label ?? "\u672a\u9078\u629e"}</button><button type="button" onClick={() => updateSettingsOpen(true)} className="shrink-0 hover:text-text">{"\u601d\u8003"}: {thinkingValue}</button></>}
      />
      {!settingsOpen && error && <p role="alert" className="mx-auto -mt-2 mb-2 max-w-3xl rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      </div>

      {settingsOpen && (
        <aside id="bot-settings-panel" role="dialog" aria-labelledby="bot-settings-title" onKeyDown={(event) => { if (event.key === "Escape") updateSettingsOpen(false); }} aria-label="ボット設定" className="flex h-full w-full shrink-0 flex-col border-bot-outline bg-bot-chat lg:w-[22rem] lg:border-l xl:w-[24.5rem]">
          <div className="flex h-[3.75rem] shrink-0 items-center justify-between px-5">
            <h2 id="bot-settings-title" className="text-sm font-medium">設定</h2>
            <button type="button" autoFocus aria-label="設定を閉じる" onClick={() => updateSettingsOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <BotAvatarPicker key={bot.id} bot={bot} onChange={updateAvatar} />
            <label className="block text-sm"><span className="font-medium">名前</span><input value={profileName} onChange={(event) => { const value = event.target.value; setProfileName(value); scheduleProfileSave(value, profileLabel); }} aria-label="ボットの名前" className="mt-2 w-full rounded-xl border border-border bg-transparent px-3 py-2.5 text-base outline-none focus:border-accent" /></label>
            <label className="block text-sm"><span className="font-medium text-muted">ラベル</span><input value={profileLabel} onChange={(event) => { const value = event.target.value; setProfileLabel(value); scheduleProfileSave(profileName, value); }} aria-label="ボットのラベル" className="mt-2 w-full rounded-xl border border-border bg-transparent px-3 py-2.5 text-base outline-none focus:border-accent" /></label>
            <label className="block text-sm text-muted"><span>説明（SOUL.md）</span><textarea aria-label="ボットの説明" value={soul} onChange={(event) => { const value = event.target.value; setSoul(value); scheduleSoulSave(value); }} rows={4} className="mt-2 w-full resize-y rounded-xl border border-border bg-transparent px-3 py-2.5 text-base leading-6 text-text outline-none focus:border-accent" /><span className="mt-1 block text-right text-xs text-muted" role="status" aria-live="polite">{savingSoul ? "保存中…" : "変更は自動保存されます"}</span></label>
            <div className="flex items-center justify-between gap-4 rounded-2xl bg-surface-2 p-4 text-sm"><span><span className="font-medium">通知</span><span className="mt-1 block text-xs leading-5 text-muted">このBotが完了したとき、または入力が必要になったときに通知</span></span><button type="button" role="switch" aria-label="通知" aria-checked={notificationsEnabled} onClick={() => void updateNotifications(!notificationsEnabled)} className={notificationsEnabled ? "relative h-6 w-11 shrink-0 rounded-full bg-primary" : "relative h-6 w-11 shrink-0 rounded-full bg-surface-3"}><span className={notificationsEnabled ? "absolute left-6 top-1 h-4 w-4 rounded-full bg-primary-fg" : "absolute left-1 top-1 h-4 w-4 rounded-full bg-primary-fg"} /></button></div>
            <div className="flex items-center justify-between gap-4 rounded-2xl bg-surface-2 p-4 text-sm"><span><span className="font-medium">Codeを常に許可</span><span className="mt-1 block text-xs leading-5 text-muted">このBotのCode依頼だけ、承認ダイアログを省略します。</span></span><button type="button" role="switch" aria-label="Codeを常に許可" aria-checked={codeAutoApprove} onClick={() => void updateCodeAutoApprove(!codeAutoApprove)} className={codeAutoApprove ? "relative h-6 w-11 shrink-0 rounded-full bg-primary" : "relative h-6 w-11 shrink-0 rounded-full bg-surface-3"}><span className={codeAutoApprove ? "absolute left-6 top-1 h-4 w-4 rounded-full bg-primary-fg" : "absolute left-1 top-1 h-4 w-4 rounded-full bg-primary-fg"} /></button></div><p className="text-right text-xs text-muted" role="status" aria-live="polite">{savingProfile ? "保存中…" : "変更は自動保存されます"}</p>
            <div className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="モデル設定"><div><span className="text-sm font-medium">モデル</span><ModelSelect value={modelValue} options={models} loading={modelsLoading} disabled={updatingModel || updatingThinking} onChange={(value) => void updateModel(value)} className="mt-2 h-9 w-full" ariaLabel="ボットのモデル" /></div><div><span className="text-sm font-medium">思考レベル</span><ThinkingSelect levels={thinkingLevels} value={thinkingValue} disabled={updatingModel || updatingThinking} onChange={(value) => void updateThinking(value)} className="mt-2 h-9 w-full" /></div>{(updatingModel || updatingThinking) && <p className="text-xs text-muted">保存中…</p>}</div>
            <details><summary className="cursor-pointer text-sm font-semibold text-muted">詳細設定</summary>
            <BotCodeSessionPanel botId={id} />
            <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="スキル設定"><div><span className="text-sm font-medium">スキルの読み込み</span><select value={bot.skills.mode} disabled={updatingSkills} onChange={(event) => void updateSkills({ ...bot.skills, mode: event.target.value as BotDto["skills"]["mode"] })} className="mt-2 h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm"><option value="inherit">継承（通常のスキル）</option><option value="include">指定したスキルだけ許可</option><option value="exclude">指定したスキルを除外</option></select></div><label className="block text-xs"><span className="font-medium">許可するスキル名（1行1件）</span><textarea value={bot.skills.include.join("\n")} disabled={updatingSkills} onChange={(event) => setBot({ ...bot, skills: { ...bot.skills, include: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) } })} onBlur={() => void updateSkills(bot.skills)} rows={3} className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" /></label><label className="block text-xs"><span className="font-medium">除外するスキル名（1行1件）</span><textarea value={bot.skills.exclude.join("\n")} disabled={updatingSkills} onChange={(event) => setBot({ ...bot, skills: { ...bot.skills, exclude: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) } })} onBlur={() => void updateSkills(bot.skills)} rows={3} className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" /></label><p className="text-[11px] text-muted">inherit は共通設定に従います。保存すると次回の応答から反映されます。</p></section>
            <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="追加ルート設定"><div><span className="text-sm font-medium">追加ルート</span><p className="mt-1 text-xs text-muted">Bot が参照できる絶対パス（Computer 分離は後続フェーズ）</p></div><div className="flex gap-2"><input value={extraRootInput} onChange={(event) => setExtraRootInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addExtraRoot(); } }} placeholder="C:\path\to\root" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" /><Button size="sm" onClick={() => void addExtraRoot()} disabled={!extraRootInput.trim()}>追加</Button></div>{bot.extraRoots.length === 0 ? <p className="text-xs text-muted">追加ルートはありません。</p> : <ul className="space-y-1">{bot.extraRoots.map((root) => <li key={root} className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 break-all">{root}</span><button type="button" onClick={() => void removeExtraRoot(root)} className="shrink-0 text-danger hover:underline">削除</button></li>)}</ul>}</section>
            <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="ルーティン設定">
              <div className="flex items-center justify-between gap-2"><div><h3 className="text-sm font-medium">ルーティン</h3><p className="mt-1 text-xs text-muted">5分以上の cron で定期実行します。</p></div><Button size="sm" onClick={() => setRoutineFormOpen((open) => !open)}>ルーティンを作成</Button></div>
              {routineFormOpen && <div className="space-y-2 rounded-xl border border-accent/40 bg-surface p-3" role="dialog" aria-label="ルーティンを作成"><p className="text-xs font-medium text-accent">ルーティンを作成（確認）</p><input value={routineName} onChange={(event) => setRoutineName(event.target.value)} placeholder="名前（例: 朝の確認）" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" /><textarea value={routinePrompt} onChange={(event) => setRoutinePrompt(event.target.value)} placeholder="Bot に実行させる指示" rows={3} className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" /><input value={routineSchedule} onChange={(event) => setRoutineSchedule(event.target.value)} aria-label="cron スケジュール" placeholder="0 * * * *" className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent" /><p className="text-[11px] text-muted">形式: 分 時 日 月 曜日（最短間隔 5 分）</p><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setRoutineFormOpen(false)}>キャンセル</Button><Button size="sm" onClick={() => void createRoutine()} busy={creatingRoutine} disabled={!routineName.trim() || !routinePrompt.trim()}>確認して保存</Button></div></div>}
              {routines.length === 0 && <p className="text-xs text-muted">登録されたルーティンはありません。</p>}
              {routines.map((routine) => <div key={routine.id} className="rounded-xl border border-border bg-surface p-3 text-xs"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-medium">{routine.name} {routine.enabled ? <span className="text-success">有効</span> : <span className="text-muted">無効</span>}</p><p className="mt-1 font-mono text-muted">{routine.schedule}</p><p className="mt-1 break-words text-muted">{routine.prompt}</p>{routine.failureCount > 0 && <p className="mt-1 text-danger">連続失敗: {routine.failureCount}回</p>}</div><div className="flex shrink-0 flex-col gap-1"><Button size="sm" variant="ghost" disabled={routineBusy === routine.id} onClick={() => void patchRoutine(routine, !routine.enabled)}>{routine.enabled ? "無効化" : "有効化"}</Button><Button size="sm" variant="ghost" disabled={routineBusy === routine.id || !routine.enabled} onClick={() => void runRoutine(routine)}>今すぐ実行</Button><button type="button" disabled={routineBusy === routine.id} onClick={() => void deleteRoutine(routine)} className="px-2 py-1 text-danger hover:underline disabled:opacity-50">削除</button></div></div></div>)}
            </section>
            </details>
            <section className="space-y-2 rounded-2xl border border-border bg-bg p-4" aria-label="会話リセット">
              <p className="text-sm font-medium">会話リセット</p>
              <p className="text-xs leading-5 text-muted">このBotとの会話履歴を削除して、新しい会話を開始します。Botの設定は残ります。</p>
              <Button size="sm" variant="ghost" onClick={() => void resetConversation()} busy={resetting}>会話をリセット</Button>
            </section>
            <div className="border-t border-border pt-4">
              <p className="text-xs text-muted">このBotと関連する会話データも削除されます。</p>
              <Button size="sm" variant="danger" onClick={() => void removeBot()} busy={deleting} className="mt-2">ボットを削除</Button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
