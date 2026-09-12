"use client";

import { memo, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Volume2, VolumeX, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getJson, sendJson } from "@/lib/client";
import { notifyBotSidebarChanged } from "@/lib/events";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { Button } from "@/components/ui";
import { ActivityLog, conversationContentClass, MessageHeader } from "@/components/ConversationLayout";
import { BotAvatarPicker, type AvatarPatch } from "@/components/bot/BotAvatarPicker";
import { BotSkillsSettings } from "@/components/bot/BotSkillsSettings";
import { BotRoutineSettings } from "@/components/bot/BotRoutineSettings";
import { BotEmptyState } from "@/components/bot/BotEmptyState";
import { BotChatHeader } from "@/components/bot/BotChatHeader";
import { useReportStatus } from "@/components/shell/TaskPanesContext";
import { BotComposer } from "@/components/bot/BotComposer";
import { type ComposerAttachment } from "@/components/Composer";
import { canAttachComposerImages, pasteImage } from "@/lib/clipboard-image";
import { BotMessageError, BotMessageImages, BotMessageList, BotChatMessage, BotMessageSender, BotPermissionCard, BotResponseStatus, BotRevertButton } from "@/components/bot/BotMessageList";
import { BotCodeSessionPanel } from "@/components/bot/BotCodeSessionPanel";
import { BotCodeRequests } from "@/components/bot/BotCodeRequests";
import { ToolPermissionList } from "@/components/ToolPermissionList";
import { QuestionCard } from "@/components/task/QuestionCard";
import { ToolCard } from "@/components/task/PartView";
import { markRead } from "@/lib/bot-unread";
import { decideNotification } from "@/lib/notify";
import { cancelPendingSseReconnect, closeSseSource, sseReconnectDelayMs } from "@/lib/sse-reconnect";
import { messageRenderKey, stabilizeUiMessages, upsertUiMessage } from "@/lib/stabilize-messages";
import {
  EMPTY_TASK_MESSAGE_HISTORY,
  mergeNewerTaskMessages,
  prependOlderTaskMessages,
} from "@/lib/task-history";
import { readTaskTtsEnabled, speakText, stopSpeaking, subscribeTaskTtsEnabled, writeTaskTtsEnabled } from "@/lib/tts-playback";
import { detectTtsBackend, getTtsBackend } from "@/lib/tts-backends";
import type { TtsConfigDto } from "@/lib/tts-config";
import { BOT_DEFAULT_TOOL_NAMES, BOT_TOOL_NAMES, type BotDto, type BotToolName, type ModelOption, type PermissionRequestDto, type QuestionRequestDto, type RoutineDto, type TaskMessageHistory, type TaskMessagePage, type ThinkingLevel, type UiMessage, type UiPart } from "@/lib/types";

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

function BotToolActivityGroup({ messages, bot, botId, active }: { messages: UiMessage[]; bot: BotDto | null; botId: string; active: boolean }) {
  const parts = messages.flatMap((message) => botMessageDisplayData(message).tools);
  return (
    <ActivityLog kind="bot" count={parts.length} parts={parts} active={active}>
      {messages.map((message) => {
        const { text, tools, images, requestIds } = botMessageDisplayData(message);
        return <div key={messageRenderKey(message)} className="min-w-0 space-y-2">
          {!text && !images.length && !message.error && !requestIds.length && <MessageHeader><BotMessageSender {...bot} name={bot?.name ?? "ボット"} createdAt={message.createdAt} /></MessageHeader>}
          {tools.map((part) => {
            const partKey = part.id || part.callID;
            const cardKey = part.state.status === "error" || part.state.status === "cancelled" ? `${partKey}:expanded` : partKey;
            return <ToolCard key={cardKey} part={part} taskId={botId} tabActive={active} />;
          })}
        </div>;
      })}
    </ActivityLog>
  );
}

const BOT_AUTO_SAVE_DELAY_MS = 600;
const BOT_SETTINGS_OPEN_KEY_PREFIX = "webui:bot-settings-open:";
const BOT_SETTINGS_WIDTH_KEY = "webui:bot-settings-width";
const BOT_SETTINGS_MIN_WIDTH = 280;
const BOT_SETTINGS_DEFAULT_WIDTH = 352;
const BOT_SETTINGS_MAX_WIDTH = 640;

function readBotSettingsWidth(): number {
  if (typeof window === "undefined") return BOT_SETTINGS_DEFAULT_WIDTH;
  try {
    const stored = window.localStorage.getItem(BOT_SETTINGS_WIDTH_KEY);
    const saved = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(saved)
      ? Math.min(BOT_SETTINGS_MAX_WIDTH, Math.max(BOT_SETTINGS_MIN_WIDTH, saved))
      : BOT_SETTINGS_DEFAULT_WIDTH;
  } catch {
    return BOT_SETTINGS_DEFAULT_WIDTH;
  }
}

function writeBotSettingsWidth(width: number): void {
  try {
    window.localStorage.setItem(BOT_SETTINGS_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

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

export const BotView = memo(function BotView({ id, active = true }: { id: string; active?: boolean }) {
  const [bot, setBot] = useState<BotDto | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [permission, setPermission] = useState<PermissionRequestDto | null>(null);
  const [question, setQuestion] = useState<QuestionRequestDto | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [messageHistory, setMessageHistory] = useState<TaskMessageHistory>(EMPTY_TASK_MESSAGE_HISTORY);
  const messageHistoryRef = useRef(messageHistory);
  const historyLoadedRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyRequestEpochRef = useRef(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [soul, setSoul] = useState("");
  const [soulEditing, setSoulEditing] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileLabel, setProfileLabel] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsConfig, setTtsConfig] = useState<TtsConfigDto | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [codeAutoApprove, setCodeAutoApprove] = useState(true);
  const [permissionMode, setPermissionMode] = useState<NonNullable<BotDto["permissionMode"]>>("allow");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsWidth, setSettingsWidth] = useState(() => readBotSettingsWidth());
  const [codePanelOpen, setCodePanelOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  const [sending, setSending] = useState(false);
  const reportStatus = useReportStatus();
  useEffect(() => {
    reportStatus(`/bots/${encodeURIComponent(id)}`, sending ? "working" : "idle");
  }, [id, sending, reportStatus]);
  const [reverting, setReverting] = useState(false);
  const [savingSoul, setSavingSoul] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [updatingThinking, setUpdatingThinking] = useState(false);
  const [updatingTtsVoice, setUpdatingTtsVoice] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingSkills, setUpdatingSkills] = useState(false);
  const [updatingTools, setUpdatingTools] = useState(false);
  const [extraRootInput, setExtraRootInput] = useState("");
  const [routines, setRoutines] = useState<RoutineDto[]>([]);
  const [routineCardOpen, setRoutineCardOpen] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [routineSchedule, setRoutineSchedule] = useState("0 * * * *");
  const [creatingRoutine, setCreatingRoutine] = useState(false);
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

  const loadOlderMessages = useCallback(async () => {
    if (historyLoadingRef.current) return;
    const history = messageHistoryRef.current;
    if (!history.hasMore || !history.nextCursor) return;
    const requestEpoch = historyRequestEpochRef.current;
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await getJson<TaskMessagePage>(
        `/api/tasks/${encodeURIComponent(`bot:${id}`)}/messages`,
        { before: history.nextCursor },
      );
      if (requestEpoch !== historyRequestEpochRef.current) return;
      setMessages((current) => prependOlderTaskMessages(current, page.messages));
      historyLoadedRef.current = true;
      messageHistoryRef.current = page.messageHistory;
      setMessageHistory(page.messageHistory);
      window.requestAnimationFrame(() => {
        const currentViewport = viewportRef.current;
        if (!currentViewport || currentViewport !== viewport) return;
        currentViewport.scrollTop = previousTop + currentViewport.scrollHeight - previousHeight;
      });
    } catch (error) {
      if (requestEpoch === historyRequestEpochRef.current) {
        setHistoryError(error instanceof Error ? error.message : "過去の履歴を読み込めませんでした");
      }
    } finally {
      historyLoadingRef.current = false;
      if (requestEpoch === historyRequestEpochRef.current) {
        setHistoryLoading(false);
      }
    }
  }, [id]);

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
        setTtsVoice(result.bot.ttsVoice ?? "");
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
    const enabled = readTaskTtsEnabled(id);
    setTtsEnabled(enabled);
    if (!enabled) stopSpeaking();
  }, [id]);
  useEffect(() => {
    if (!active || !settingsOpen) return;
    let current = true;
    setTtsConfig(null);
    void getJson<TtsConfigDto>("/api/settings/tts")
      .then((result) => { if (current) setTtsConfig(typeof result?.url === "string" ? result : null); })
      .catch(() => { if (current) setTtsConfig(null); });
    return () => { current = false; };
  }, [active, settingsOpen]);
  const toggleTts = () => {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    setTtsError(null);
    writeTaskTtsEnabled(id, next);
    if (!next) stopSpeaking();
  };
  useEffect(() => subscribeTaskTtsEnabled(id, (enabled) => {
    setTtsEnabled(enabled);
    if (!enabled) stopSpeaking();
  }), [id]);
  // Drop the previous bot's transcript/overlays immediately; SSE will refill for the new id.
  useEffect(() => {
    setMessages([]);
    messageHistoryRef.current = EMPTY_TASK_MESSAGE_HISTORY;
    setMessageHistory(EMPTY_TASK_MESSAGE_HISTORY);
    historyLoadedRef.current = false;
    historyLoadingRef.current = false;
    historyRequestEpochRef.current += 1;
    setHistoryLoading(false);
    setHistoryError(null);
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
  // 発言が完了した（working → idle）タイミングで、直前のBotの返信をこのタブでだけ読み上げる。
  // 非表示タブ（裏のペイン等）は喋らない。完了通知が履歴更新より先に届いても待つ。
  const prevTtsSendingRef = useRef(false);
  const ttsBaselineAssistantIdRef = useRef<string | null>(null);
  const ttsPendingRef = useRef(false);
  const ttsBotIdRef = useRef(id);
  useEffect(() => {
    if (ttsBotIdRef.current !== id) {
      ttsBotIdRef.current = id;
      prevTtsSendingRef.current = sending;
      ttsBaselineAssistantIdRef.current = null;
      ttsPendingRef.current = false;
      return;
    }
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!prevTtsSendingRef.current && sending) {
      ttsBaselineAssistantIdRef.current = lastAssistant?.id ?? null;
      ttsPendingRef.current = false;
    } else if (prevTtsSendingRef.current && !sending) {
      ttsPendingRef.current = Boolean(ttsEnabled && active);
    }
    if (!ttsEnabled || !active) ttsPendingRef.current = false;
    if (!sending && ttsPendingRef.current && lastAssistant && lastAssistant.id !== ttsBaselineAssistantIdRef.current) {
      ttsPendingRef.current = false;
      speakText(botMessageDisplayData(lastAssistant).text, {
        botId: id,
        onError: setTtsError,
        onPlayed: () => setTtsError(null),
      });
    }
    prevTtsSendingRef.current = sending;
  }, [active, id, sending, ttsEnabled, messages]);
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
            messageHistory?: TaskMessageHistory;
            historyReset?: boolean;
            isStreaming?: boolean;
            error?: string;
            permissionRequest?: PermissionRequestDto | null;
            questionRequest?: QuestionRequestDto | null;
            eventType?: string;
          };
          const resetHistory = payload.historyReset === true || payload.eventType === "revert" || payload.eventType === "unrevert";
          if (resetHistory) {
            historyRequestEpochRef.current += 1;
            historyLoadedRef.current = false;
            historyLoadingRef.current = false;
            messageHistoryRef.current = EMPTY_TASK_MESSAGE_HISTORY;
            setMessageHistory(EMPTY_TASK_MESSAGE_HISTORY);
            setHistoryLoading(false);
            setHistoryError(null);
            setMessages(() => stabilizeUiMessages([], payload.messages ?? []));
          } else if (payload.messages) {
            setMessages((current) => mergeNewerTaskMessages(current, payload.messages!));
          }
          if (payload.messageHistory && (!historyLoadedRef.current || resetHistory)) {
            messageHistoryRef.current = payload.messageHistory;
            setMessageHistory(payload.messageHistory);
          }
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
  const ttsBackend = ttsConfig ? getTtsBackend(detectTtsBackend(ttsConfig.url)) : null;
  const ttsVoiceOptions = useMemo(() => {
    const options = ttsBackend?.id === "sapi" || !ttsBackend ? [] : [...ttsBackend.voices];
    if (ttsVoice && !options.some((option) => option.id === ttsVoice)) options.unshift({ id: ttsVoice, label: `現在の設定 (${ttsVoice})` });
    return options;
  }, [ttsBackend, ttsVoice]);
  // Bot設定の保存たびに bot 参照が変わっても、表示名・見た目が同じなら同一配列を使い回す。
  // BotMessageMarkdown の memo が効き続け、履歴全体の再パースを避けられる。
  const botMentions = useMemo(() => bot ? [bot] : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bot?.id, bot?.name, bot?.avatarColor, bot?.avatarShape, bot?.avatarEyeColor, bot?.avatarGlasses, bot?.avatarMustache, bot?.avatarImage]);

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

  const updateTtsVoice = async (value: string) => {
    if (!bot || updatingTtsVoice) return;
    const previous = ttsVoice;
    const next = value.trim();
    setTtsVoice(next);
    setUpdatingTtsVoice(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { ttsVoice: next || null }, "PATCH");
      applyBotUpdate(result.bot);
      setTtsVoice(result.bot.ttsVoice ?? "");
    } catch (reason) {
      setTtsVoice(previous);
      setError(reason instanceof Error ? reason.message : "TTS音声の保存に失敗しました");
    } finally { setUpdatingTtsVoice(false); }
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
    try { await sendJson(`/api/bots/${encodeURIComponent(id)}/routines`, { name: routineName, prompt: routinePrompt, schedule: routineSchedule }, "POST"); setRoutineName(""); setRoutinePrompt(""); setRoutineSchedule("0 * * * *"); setRoutineCardOpen(false); await loadRoutines(); }
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
    const groupedTools: UiMessage[] = [];
    let groupKey: string | null = null;
    const flushTools = () => {
      if (groupedTools.length === 0 || groupKey === null) return;
      rows.push(
        <BotToolActivityGroup
          key={`tool-group:${groupKey}`}
          messages={groupedTools.splice(0)}
          bot={bot}
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
        groupedTools.push(message);
        continue;
      }

      if (tools.length > 0) {
        if (groupKey === null) groupKey = messageRenderKey(message);
        groupedTools.push(message);
      }
      flushTools();
      if (!text && images.length === 0 && tools.length === 0 && !message.error && requestIds.length === 0) {
        continue;
      }
      const hasBubble = user || Boolean(text || images.length > 0 || message.error || requestIds.length > 0);
      rows.push(
        <BotChatMessage key={messageRenderKey(message)} user={user} createdAt={message.createdAt}
          sender={{ ...(bot ?? {}), name: bot?.name ?? "ボット" }} text={text} mentions={botMentions}
          images={<BotMessageImages images={images.flatMap((part) => part.type === "image" ? [{ key: part.id, src: part.url, alt: part.filename ?? undefined }] : [])} />}
          bubble={hasBubble}
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
        action={
          <>
            {ttsError && <span role="alert" title={ttsError} className="max-w-40 shrink-0 truncate text-[11px] text-danger">{ttsError}</span>}
            <button
              type="button"
              role="switch"
              aria-checked={ttsEnabled}
              aria-label="読み上げ"
              title={ttsEnabled ? "読み上げ: ON" : "読み上げ: OFF"}
              onClick={toggleTts}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ttsEnabled ? "text-accent" : "text-muted"} hover:bg-surface-2 hover:text-text`}
            >
              {ttsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          </>
        }
      />


      <BotMessageList
        conversationId={id}
        contentKey={chatScrollKey}
        viewportRef={viewportRef}
        onReachTop={() => void loadOlderMessages()}
      >
        <div className={conversationContentClass}>
          {messageHistory.hasMore && (
            <div className="flex flex-col items-center gap-1 py-1" role="status" aria-live="polite">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void loadOlderMessages()}
                busy={historyLoading}
                disabled={historyLoading}
              >
                {!historyLoading && <span aria-hidden="true">↑</span>}
                {historyLoading ? "過去の履歴を読み込み中…" : "過去の履歴を読み込む"}
              </Button>
              {historyError && <span className="text-xs text-danger">{historyError}</span>}
            </div>
          )}
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
        <aside id="bot-settings-panel" role="dialog" aria-labelledby="bot-settings-title" onKeyDown={(event) => { if (event.key === "Escape") updateSettingsOpen(false); }} aria-label="ボット設定" className="relative flex h-full w-full shrink-0 flex-col border-bot-outline bg-bot-chat lg:w-(--bot-settings-width) lg:border-l" style={{ "--bot-settings-width": `${settingsWidth}px` } as CSSProperties}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="ボット設定の幅を調整"
            aria-valuemin={BOT_SETTINGS_MIN_WIDTH}
            aria-valuemax={BOT_SETTINGS_MAX_WIDTH}
            aria-valuenow={settingsWidth}
            tabIndex={0}
            className="absolute top-0 left-0 z-10 hidden h-full w-1 cursor-col-resize lg:block"
            onKeyDown={(event) => {
              const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
              if (!delta) return;
              event.preventDefault();
              const nextWidth = Math.min(BOT_SETTINGS_MAX_WIDTH, Math.max(BOT_SETTINGS_MIN_WIDTH, settingsWidth + delta));
              setSettingsWidth(nextWidth);
              writeBotSettingsWidth(nextWidth);
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              const startX = event.clientX;
              const startWidth = settingsWidth;
              let nextWidth = settingsWidth;
              const previousUserSelect = document.body.style.userSelect;
              document.body.style.userSelect = "none";
              const onMove = (move: PointerEvent) => {
                nextWidth = Math.min(
                  BOT_SETTINGS_MAX_WIDTH,
                  Math.max(BOT_SETTINGS_MIN_WIDTH, startWidth - (move.clientX - startX)),
                );
                setSettingsWidth(nextWidth);
              };
              const onUp = () => {
                document.body.style.userSelect = previousUserSelect;
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onUp);
                window.removeEventListener("blur", onUp);
                writeBotSettingsWidth(nextWidth);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
              window.addEventListener("pointercancel", onUp);
              window.addEventListener("blur", onUp);
            }}
          />
          <div className="flex h-[3.75rem] shrink-0 items-center justify-between px-5">
            <h2 id="bot-settings-title" className="text-sm font-medium">設定</h2>
            <button type="button" autoFocus aria-label="設定を閉じる" onClick={() => updateSettingsOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <BotAvatarPicker key={bot.id} bot={bot} onChange={updateAvatar} />
            <label className="block text-sm"><span className="font-medium">名前</span><input value={profileName} onChange={(event) => { const value = event.target.value; setProfileName(value); scheduleProfileSave(value, profileLabel); }} aria-label="ボットの名前" className="mt-2 w-full rounded-xl border border-border bg-transparent px-3 py-2.5 text-base outline-none focus:border-accent" /></label>
            <label className="block text-sm"><span className="font-medium text-muted">ラベル</span><input value={profileLabel} onChange={(event) => { const value = event.target.value; setProfileLabel(value); scheduleProfileSave(profileName, value); }} aria-label="ボットのラベル" className="mt-2 w-full rounded-xl border border-border bg-transparent px-3 py-2.5 text-base outline-none focus:border-accent" /></label>
            <div className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="モデル設定"><div><span className="text-sm font-medium">モデル</span><ModelSelect value={modelValue} options={models} loading={modelsLoading} disabled={updatingModel || updatingThinking} onChange={(value) => void updateModel(value)} className="mt-2 h-9 w-full" ariaLabel="ボットのモデル" /></div><div><span className="text-sm font-medium">思考レベル</span><ThinkingSelect levels={thinkingLevels} value={thinkingValue} disabled={updatingModel || updatingThinking} onChange={(value) => void updateThinking(value)} className="mt-2 h-9 w-full" /></div><label className="block"><span className="text-sm font-medium">TTS音声</span>{ttsVoiceOptions.length > 0 ? <select aria-label="ボットのTTS音声" value={ttsVoice} disabled={updatingTtsVoice} onChange={(event) => void updateTtsVoice(event.target.value)} className="mt-2 h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm outline-none focus:border-accent disabled:opacity-60"><option value="">グローバル設定を使用</option>{ttsVoiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input type="text" value={ttsVoice} disabled={updatingTtsVoice} placeholder="空欄ならグローバル設定" aria-label="ボットのTTS音声" onChange={(event) => setTtsVoice(event.target.value)} onBlur={() => void updateTtsVoice(ttsVoice)} className="mt-2 h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm outline-none focus:border-accent disabled:opacity-60" />}<span className="mt-1 block text-xs text-muted">空欄なら全体設定の音声を使います。</span></label>{(updatingModel || updatingThinking || updatingTtsVoice) && <p className="text-xs text-muted">保存中…</p>}</div>
            <div className="block text-sm text-muted">
              <div className="flex items-center justify-between gap-2">
                <span>説明（SOUL.md）</span>
                {!soulEditing && <Button type="button" size="sm" variant="secondary" onClick={() => setSoulEditing(true)}>編集</Button>}
              </div>
              {soulEditing ? (
                <>
                  <textarea aria-label="ボットの説明" value={soul} onChange={(event) => { const value = event.target.value; setSoul(value); scheduleSoulSave(value); }} rows={4} className="mt-2 h-48 w-full resize-none overflow-y-auto rounded-xl border border-border bg-transparent px-3 py-2.5 text-base leading-6 text-text outline-none focus:border-accent" />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-xs" role="status" aria-live="polite">{savingSoul ? "保存中…" : "変更は自動保存されます"}</span>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setSoulEditing(false)}>表示</Button>
                  </div>
                </>
              ) : soul.trim() ? (
                <div className="md mt-2 h-48 overflow-y-auto rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-base leading-6 text-text">
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
            <BotSkillsSettings skills={bot.skills} disabled={updatingSkills} onChange={updateSkills} />
            <BotRoutineSettings botId={id} routines={routines} onRefresh={loadRoutines} onError={setError} />
            <details><summary className="cursor-pointer text-sm font-semibold text-muted">詳細設定</summary>
            <section className="space-y-3 rounded-2xl border border-border bg-bg p-4" aria-label="追加ルート設定"><div><span className="text-sm font-medium">追加ルート</span><p className="mt-1 text-xs text-muted">Bot が参照できる絶対パス（Computer 分離は後続フェーズ）</p></div><div className="flex gap-2"><input value={extraRootInput} onChange={(event) => setExtraRootInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addExtraRoot(); } }} placeholder="C:\path\to\root" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs" /><Button size="sm" onClick={() => void addExtraRoot()} disabled={!extraRootInput.trim()}>追加</Button></div>{bot.extraRoots.length === 0 ? <p className="text-xs text-muted">追加ルートはありません。</p> : <ul className="space-y-1">{bot.extraRoots.map((root) => <li key={root} className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 break-all">{root}</span><button type="button" onClick={() => void removeExtraRoot(root)} className="shrink-0 text-danger hover:underline">削除</button></li>)}</ul>}</section>
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
});
