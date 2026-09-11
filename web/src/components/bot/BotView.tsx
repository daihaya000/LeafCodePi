"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getJson, sendJson } from "@/lib/client";
import { notifyBotSidebarChanged } from "@/lib/events";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { Button, formatDuration } from "@/components/ui";
import { BotAvatarPicker, type AvatarPatch } from "@/components/bot/BotAvatarPicker";
import { BotSkillsSettings } from "@/components/bot/BotSkillsSettings";
import { BotEmptyState } from "@/components/bot/BotEmptyState";
import { BotChatHeader } from "@/components/bot/BotChatHeader";
import { useTaskPanes } from "@/components/shell/TaskPanesContext";
import { BotComposer } from "@/components/bot/BotComposer";
import { type ComposerAttachment } from "@/components/Composer";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { BotMessageError, BotMessageImages, BotMessageList, BotChatMessage, BotPermissionCard, BotResponseStatus, BotRevertButton } from "@/components/bot/BotMessageList";
import { BotCodeSessionPanel } from "@/components/bot/BotCodeSessionPanel";
import { BotCodeRequests } from "@/components/bot/BotCodeRequests";
import { ToolPermissionList } from "@/components/ToolPermissionList";
import { QuestionCard } from "@/components/task/QuestionCard";
import { ToolCard } from "@/components/task/PartView";
import { markRead } from "@/lib/bot-unread";
import { decideNotification } from "@/lib/notify";
import { cancelPendingSseReconnect, closeSseSource, sseReconnectDelayMs } from "@/lib/sse-reconnect";
import { messageRenderKey, stabilizeUiMessages, upsertUiMessage } from "@/lib/stabilize-messages";
import { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES, type BotDto, type BotToolName, type ModelOption, type PermissionRequestDto, type QuestionRequestDto, type RoutineDto, type ThinkingLevel, type UiMessage, type UiPart } from "@/lib/types";

type BotMessageDisplayData = {
  text: string;
  images: Extract<UiPart, { type: "image" }>[];
  tools: Extract<UiPart, { type: "tool" }>[];
  requestIds: string[];
};

const botMessageDisplayCache = new WeakMap<UiMessage, BotMessageDisplayData>();

function botMessageDisplayData(message: UiMessage): BotMessageDisplayData {
  const cached = botMessageDisplayCache.get(message);
  if (cached) return cached;

  const images = message.parts.filter((part): part is Extract<UiPart, { type: "image" }> => part.type === "image");
  const tools = message.role === "assistant"
    ? message.parts.filter((part): part is Extract<UiPart, { type: "tool" }> => part.type === "tool")
    : [];
  const requestIds = message.role === "assistant" ? message.parts.flatMap((part) => {
    if (part.type !== "tool" || part.tool !== "code_session" || !part.state.output) return [];
    try {
      const result = JSON.parse(part.state.output);
      return typeof result?.requestId === "string" ? [result.requestId] : [];
    } catch { return []; }
  }) : [];
  const data = {
    text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
    images,
    tools,
    requestIds,
  } satisfies BotMessageDisplayData;
  botMessageDisplayCache.set(message, data);
  return data;
}

type BotToolPart = Extract<UiPart, { type: "tool" }>;

function BotToolActivityGroup({ parts, botId, active }: { parts: BotToolPart[]; botId: string; active: boolean }) {
  // 完了したツールのみ合算する（実行中は確定してから加算）。
  const durationMs = parts.reduce((total, part) => {
    const { startedAtMs, endedAtMs } = part.state;
    if (startedAtMs === undefined || endedAtMs === undefined) return total;
    return total + Math.max(0, endedAtMs - startedAtMs);
  }, 0);
  return (
    <details
      data-bot-tool-group
      aria-label="ツール実行"
      className="group/tool-activity w-full max-w-bubble self-start overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-surface-2 px-3 py-2.5 text-left text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open/tool-activity:rotate-90" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium">ツール実行</span>
        <span className="shrink-0 text-xs text-faint">
          {parts.length}件{durationMs > 0 ? ` · ${formatDuration(durationMs)}` : ""}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border bg-surface p-2">
        {parts.map((part) => {
          const partKey = part.id || part.callID;
          const cardKey =
            part.state.status === "error" || part.state.status === "cancelled"
              ? `${partKey}:expanded`
              : partKey;
          return <ToolCard key={cardKey} part={part} taskId={botId} tabActive={active} />;
        })}
      </div>
    </details>
  );
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
  const [soulEditing, setSoulEditing] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileLabel, setProfileLabel] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [codeAutoApprove, setCodeAutoApprove] = useState(true);
  const [permissionMode, setPermissionMode] = useState<NonNullable<BotDto["permissionMode"]>>("allow");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codePanelOpen, setCodePanelOpen] = useState(false);
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
  const [updatingTools, setUpdatingTools] = useState(false);
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

  const load = useCallback((isCurrent: () => boolean) => {
    return getJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`)
      .then((result) => {
        if (!isCurrent()) return;
        profileDraftRef.current = { name: result.bot.name, label: result.bot.label };
        soulDraftRef.current = result.bot.soul;
        setBot(result.bot);
        setSoul(result.bot.soul);
        setSoulEditing(false);
        setProfileName(result.bot.name);
        setProfileLabel(result.bot.label);
        setNotificationsEnabled(result.bot.notificationsEnabled);
        setCodeAutoApprove(result.bot.codeAutoApprove === true);
        setPermissionMode(result.bot.permissionMode ?? "allow");
      })
      .catch((reason) => {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : "読み込みに失敗しました");
      });
  }, [id]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void load(() => current);
    return () => { current = false; };
  }, [active, load]);
  useEffect(() => {
    const saved = readBotSettingsOpen(id);
    settingsOpenRef.current = saved;
    setSettingsOpen(saved);
    setCodePanelOpen(false);
  }, [id]);
  // Drop the previous bot's transcript/overlays immediately; SSE will refill for the new id.
  useEffect(() => {
    setMessages([]);
    setPermission(null);
    setQuestion(null);
    setSending(false);
    setError(null);
    setPrompt("");
    setAttachments([]);
    setRoutines([]);
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
  // A Bot that finishes answering while you are on another tab should still reach you. The per-Bot
  // notification toggle decides whether this Bot may interrupt you at all.
  const prevAttentionRef = useRef(false);
  const prevWorkingRef = useRef(false);
  useEffect(() => {
    if (typeof Notification === "undefined" || !bot) return;
    const attentionNow = Boolean(permission || question);
    const kind = decideNotification({
      prevAttention: prevAttentionRef.current, attention: attentionNow,
      prevWorking: prevWorkingRef.current, working: sending,
      documentHidden: typeof document !== "undefined" && document.hidden,
      permission: Notification.permission,
    });
    prevAttentionRef.current = attentionNow;
    prevWorkingRef.current = sending;
    // One notification per Bot replaces the previous one instead of stacking.
    if (kind && notificationsEnabled) new Notification(kind === "attention" ? "承認が必要です" : "新しい返信があります", { body: bot.name, tag: `bot-${id}` });
  }, [bot, id, notificationsEnabled, permission, question, sending]);
  const loadRoutines = useCallback((isCurrent: () => boolean = () => true) => getJson<{ routines: RoutineDto[] }>(`/api/bots/${encodeURIComponent(id)}/routines`)
    .then((result) => { if (isCurrent()) setRoutines(result.routines); })
    .catch((reason) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : "\u30eb\u30fc\u30c6\u30a3\u30f3\u3092\u8aad\u307f\u8fbc\u3081\u307e\u305b\u3093\u3067\u3057\u305f"); }), [id]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void loadRoutines(() => current);
    return () => { current = false; };
  }, [active, loadRoutines]);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    setModelsLoading(true);
    void getJson<{ models: ModelOption[] }>("/api/models")
      .then((result) => { if (mounted) setModels(result.models); })
      .catch((reason) => { if (mounted) setError(reason instanceof Error ? reason.message : "モデルを読み込めませんでした"); })
      .finally(() => { if (mounted) setModelsLoading(false); });
    return () => { mounted = false; };
  }, [active]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const connect = () => {
      if (closed) return;
      retry = cancelPendingSseReconnect(retry);
      source = closeSseSource(source);
      source = new EventSource(`/api/bots/${encodeURIComponent(id)}/events?epoch=${Date.now()}`);
      source.addEventListener("snapshot", (event) => {
        if (closed) return;
        retryCount = 0;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            messages?: UiMessage[];
            isStreaming?: boolean;
            error?: string;
            permissionRequest?: PermissionRequestDto | null;
            questionRequest?: QuestionRequestDto | null;
          };
          if (payload.messages) setMessages((current) => stabilizeUiMessages(current, payload.messages!));
          const permission = payload.permissionRequest ?? null;
          setPermission((current) => current?.id === permission?.id ? current : permission);
          const question = payload.questionRequest ?? null;
          setQuestion((current) => current?.id === question?.id ? current : question);
          setSending(Boolean(payload.isStreaming));
          if (payload.error) setError(payload.error);
        } catch { setError("イベントの解析に失敗しました"); }
      });
      source.addEventListener("delta", (event) => {
        if (closed) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            message?: UiMessage | null;
            isStreaming?: boolean;
          };
          if (payload.message) {
            setMessages((current) => upsertUiMessage(current, payload.message!));
          }
          if (payload.isStreaming !== undefined) setSending(payload.isStreaming);
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

  const selectedModel = useMemo(
    () => modelOptionForValue(models, bot?.model) ?? models[0],
    [bot?.model, models],
  );
  const modelValue = selectedModel?.value ?? bot?.model ?? "";
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const thinkingValue: ThinkingLevel = bot?.thinkingLevel && thinkingLevels.includes(bot.thinkingLevel)
    ? bot.thinkingLevel
    : (thinkingLevels[0] ?? "off");
  const botMentions = useMemo(() => bot ? [bot] : [], [bot]);

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
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(`bot:${id}`)}/question`, { requestId: request.id, ...(answers ? { answers } : { reject: true }) });
      setQuestion((current) => current?.id === request.id ? null : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "質問への回答に失敗しました");
    }
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

  const updateTools = async (tools: BotToolName[]) => {
    setUpdatingTools(true);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { tools }, "PATCH");
      applyBotUpdate(result.bot);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ツール設定の保存に失敗しました"); }
    finally { setUpdatingTools(false); }
  };

  const updatePermissionMode = async (value: NonNullable<BotDto["permissionMode"]>) => {
    const previous = permissionMode;
    setPermissionMode(value);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { permissionMode: value }, "PATCH");
      applyBotUpdate(result.bot);
      setPermissionMode(result.bot.permissionMode ?? "allow");
    } catch (reason) {
      setPermissionMode(previous);
      setError(reason instanceof Error ? reason.message : "ツール権限の保存に失敗しました");
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
    const rows: ReactNode[] = [];
    const groupedTools: BotToolPart[] = [];
    let groupKey: string | null = null;
    const flushTools = () => {
      if (groupedTools.length === 0 || groupKey === null) return;
      rows.push(
        <BotToolActivityGroup
          key={`tool-group:${groupKey}`}
          parts={groupedTools.splice(0)}
          botId={`bot:${id}`}
          active={active}
        />,
      );
      groupKey = null;
    };

    for (const message of messages) {
      const user = message.role === "user";
      const { text, images, tools, requestIds } = botMessageDisplayData(message);
      const toolOnly =
        !user &&
        !text &&
        images.length === 0 &&
        tools.length > 0 &&
        !message.error &&
        requestIds.length === 0;
      if (toolOnly) {
        if (groupKey === null) groupKey = messageRenderKey(message);
        groupedTools.push(...tools);
        continue;
      }

      flushTools();
      if (!text && images.length === 0 && tools.length === 0 && !message.error && requestIds.length === 0) {
        continue;
      }
      const hasBubble = user || Boolean(text || images.length > 0 || message.error || requestIds.length > 0);
      const toolCards = tools.length > 0 ? (
        <BotToolActivityGroup parts={tools} botId={`bot:${id}`} active={active} />
      ) : undefined;
      rows.push(
        <BotChatMessage key={messageRenderKey(message)} user={user} createdAt={message.createdAt}
          sender={{ ...(bot ?? {}), name: bot?.name ?? "ボット" }} text={text} mentions={botMentions}
          images={<BotMessageImages images={images.flatMap((part) => part.type === "image" ? [{ key: part.id, src: part.url, alt: part.filename ?? undefined }] : [])} />}
          after={toolCards} bubble={hasBubble}
          footer={user ? <BotRevertButton title="このコメントを入力欄に戻して巻き戻す" disabled={reverting || sending} onClick={() => void revertMessage(message)} /> : undefined}>
          {message.error && <BotMessageError text={message.error} />}
          {requestIds.length > 0 && <BotCodeRequests botId={id} requestIds={requestIds} active={active} />}
        </BotChatMessage>,
      );
    }
    flushTools();
    return rows;
  }, [active, bot, botMentions, id, messages, reverting, sending]);

  // Overlay cards live outside `messages`; include them so follow-scroll still reaches permission/question UI.
  const routineFailuresKey = routines
    .filter((routine) => routine.failureCount > 0)
    .map((routine) => `${routine.id}:${routine.failureCount}:${routine.enabled ? 1 : 0}`)
    .join(",");
  const chatScrollKey = useMemo(() => ({
    messages,
    permissionId: permission?.id ?? null,
    questionId: question?.id ?? null,
    sending,
    routineCardOpen,
    codePanelOpen,
    routineFailures: routineFailuresKey,
  }), [messages, permission?.id, question?.id, sending, routineCardOpen, codePanelOpen, routineFailuresKey]);

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


      <BotMessageList conversationId={id} contentKey={chatScrollKey}>
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {messages.length === 0 && !sending && <BotEmptyState avatar={bot} title={bot.name + " \u3068\u8a71\u3059"} description={"\u4e0b\u306e\u5165\u529b\u6b04\u304b\u3089\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u9001\u3063\u3066\u4f1a\u8a71\u3092\u59cb\u3081\u307e\u3057\u3087\u3046\u3002"} />}
          {routines.some((routine) => routine.failureCount > 0) && <div role="status" className="rounded-2xl border border-danger/40 bg-danger/5 p-4 text-sm"><p className="font-medium text-danger">{"\u30eb\u30fc\u30c6\u30a3\u30f3\u306e\u5b9f\u884c\u306b\u5931\u6557\u3057\u3066\u3044\u307e\u3059"}</p><div className="mt-2 space-y-1 text-xs text-muted">{routines.filter((routine) => routine.failureCount > 0).map((routine) => <p key={routine.id}><span className="font-medium text-text">{routine.name}</span>{"\uFF1A"}{"\u9023\u7d9a\u5931\u6557"} {routine.failureCount}{"\u56de"}{routine.enabled ? "" : "\u3002\u5b89\u5168\u306e\u305f\u3081\u81ea\u52d5\u7684\u306b\u7121\u52b9\u5316\u3057\u307e\u3057\u305f"}</p>)}</div></div>}
          {routineCardOpen && <div className="rounded-2xl border border-accent/40 bg-surface p-4 shadow-sm" role="dialog" aria-label="ルーティン作成の確認"><p className="font-medium text-accent">ルーティンを作成</p><p className="mt-1 text-xs text-muted">内容を確認してから保存します。</p><div className="mt-3 space-y-2"><input value={routineName} onChange={(event) => setRoutineName(event.target.value)} placeholder="名前（例: 朝の確認）" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" /><textarea value={routinePrompt} onChange={(event) => setRoutinePrompt(event.target.value)} placeholder="Bot に実行させる指示" rows={3} className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" /><input value={routineSchedule} onChange={(event) => setRoutineSchedule(event.target.value)} aria-label="cron スケジュール" placeholder="0 * * * *" className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent" /><p className="text-[11px] text-muted">形式: 分 時 日 月 曜日（最短間隔 5 分）</p></div><div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setRoutineCardOpen(false)}>キャンセル</Button><Button size="sm" onClick={() => void createRoutine()} busy={creatingRoutine} disabled={!routineName.trim() || !routinePrompt.trim() || !routineSchedule.trim()}>この内容で作成</Button></div></div>}
          {rendered}
          {permission && <BotPermissionCard label="権限の確認" title="権限の確認が必要です" message={permission.message} command={permission.command} onAllow={() => void respond(true)} onDeny={() => void respond(false)} />}
          {question && <QuestionCard request={question} onReply={answerQuestion} onReject={(request) => answerQuestion(request)} />}
          {sending && <BotResponseStatus messages={messages} avatar={bot} />}
          {codePanelOpen && <BotCodeSessionPanel botId={id} onClose={() => setCodePanelOpen(false)} />}
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
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composingRef.current) { event.preventDefault(); void send(); } }}
        placeholder={`${bot.name}\u306b\u30e1\u30c3\u30bb\u30fc\u30b8（Ctrl+Enterで送信、Enterで改行）`}
        sendDisabled={!prompt.trim() && attachments.length === 0}
        busy={sending}
        onSend={() => void send()}
        onAbort={() => void abort()}
        footer={<><button type="button" onClick={() => setRoutineCardOpen(true)} className="shrink-0 font-medium text-accent hover:underline">{"\u30eb\u30fc\u30c6\u30a3\u30f3\u3092\u4f5c\u6210"}</button><button type="button" aria-expanded={codePanelOpen} aria-controls="bot-code-session-panel" onClick={() => setCodePanelOpen((open) => !open)} className="shrink-0 font-medium text-accent hover:underline">Codeを操作</button><button type="button" onClick={() => updateSettingsOpen(true)} className="truncate hover:text-text">{"\u30e2\u30c7\u30eb"}: {selectedModel?.label ?? "\u672a\u9078\u629e"}</button><button type="button" onClick={() => updateSettingsOpen(true)} className="shrink-0 hover:text-text">{"\u601d\u8003"}: {thinkingValue}</button></>}
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
            <div className="block text-sm text-muted">
              <div className="flex items-center justify-between gap-2">
                <span>説明（SOUL.md）</span>
                {!soulEditing && <Button type="button" size="sm" variant="secondary" onClick={() => setSoulEditing(true)}>編集</Button>}
              </div>
              {soulEditing ? (
                <>
                  <textarea aria-label="ボットの説明" value={soul} onChange={(event) => { const value = event.target.value; setSoul(value); scheduleSoulSave(value); }} rows={4} className="mt-2 w-full resize-y rounded-xl border border-border bg-transparent px-3 py-2.5 text-base leading-6 text-text outline-none focus:border-accent" />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-xs" role="status" aria-live="polite">{savingSoul ? "保存中…" : "変更は自動保存されます"}</span>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setSoulEditing(false)}>表示</Button>
                  </div>
                </>
              ) : soul.trim() ? (
                <div className="md mt-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-base leading-6 text-text">
                  <Markdown remarkPlugins={[remarkGfm]}>{soul}</Markdown>
                </div>
              ) : (
                <p className="mt-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm">説明はまだありません。</p>
              )}
            </div>
            <div className="flex items-center justify-between gap-4 rounded-2xl bg-surface-2 p-4 text-sm"><span><span className="font-medium">通知</span><span className="mt-1 block text-xs leading-5 text-muted">このBotが完了したとき、または入力が必要になったときに通知</span></span><button type="button" role="switch" aria-label="通知" aria-checked={notificationsEnabled} onClick={() => void updateNotifications(!notificationsEnabled)} className={notificationsEnabled ? "relative h-6 w-11 shrink-0 rounded-full bg-primary" : "relative h-6 w-11 shrink-0 rounded-full bg-surface-3"}><span className={notificationsEnabled ? "absolute left-6 top-1 h-4 w-4 rounded-full bg-primary-fg" : "absolute left-1 top-1 h-4 w-4 rounded-full bg-primary-fg"} /></button></div>
            <div className="flex items-center justify-between gap-4 rounded-2xl bg-surface-2 p-4 text-sm"><span><span className="font-medium">Codeを常に許可</span><span className="mt-1 block text-xs leading-5 text-muted">このBotのCode依頼だけ、承認ダイアログを省略します。</span></span><button type="button" role="switch" aria-label="Codeを常に許可" aria-checked={codeAutoApprove} onClick={() => void updateCodeAutoApprove(!codeAutoApprove)} className={codeAutoApprove ? "relative h-6 w-11 shrink-0 rounded-full bg-primary" : "relative h-6 w-11 shrink-0 rounded-full bg-surface-3"}><span className={codeAutoApprove ? "absolute left-6 top-1 h-4 w-4 shrink-0 rounded-full bg-primary-fg" : "absolute left-1 top-1 h-4 w-4 shrink-0 rounded-full bg-primary-fg"} /></button></div>
            <label className="block text-sm"><span className="font-medium">ツール権限</span><select aria-label="ツール権限" value={permissionMode} onChange={(event) => void updatePermissionMode(event.target.value as NonNullable<BotDto["permissionMode"]>)} className="mt-2 h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm"><option value="allow">すべて許可</option><option value="ask">実行前に確認</option><option value="deny">すべて拒否</option></select><span className="mt-1 block text-xs text-muted">Botがツールを実行するときの確認方法です。</span></label>
            <section className="space-y-2 rounded-2xl border border-border bg-bg p-4" aria-label="個別ツール設定"><span className="text-sm font-medium">使用するツール</span><ToolPermissionList<BotToolName> tools={BOT_TOOL_NAMES} selectedTools={bot.tools ?? BOT_DEFAULT_TOOL_NAMES} disabled={updatingTools} onChange={(tools) => void updateTools(tools)} /><p className="text-[11px] text-muted">チェックを外したツールはBotから利用できません。</p></section><p className="text-right text-xs text-muted" role="status" aria-live="polite">{savingProfile ? "保存中…" : "変更は自動保存されます"}</p>
            <div className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="モデル設定"><div><span className="text-sm font-medium">モデル</span><ModelSelect value={modelValue} options={models} loading={modelsLoading} disabled={updatingModel || updatingThinking} onChange={(value) => void updateModel(value)} className="mt-2 h-9 w-full" ariaLabel="ボットのモデル" /></div><div><span className="text-sm font-medium">思考レベル</span><ThinkingSelect levels={thinkingLevels} value={thinkingValue} disabled={updatingModel || updatingThinking} onChange={(value) => void updateThinking(value)} className="mt-2 h-9 w-full" /></div>{(updatingModel || updatingThinking) && <p className="text-xs text-muted">保存中…</p>}</div>
            <BotSkillsSettings skills={bot.skills} disabled={updatingSkills} onChange={updateSkills} />
            <details><summary className="cursor-pointer text-sm font-semibold text-muted">詳細設定</summary>
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
