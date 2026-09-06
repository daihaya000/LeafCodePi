"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Settings2, X } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { Button } from "@/components/ui";
import { BotAvatar } from "@/components/bot/BotAvatar";
import { AVATAR_IMAGE_ACCEPT, BOT_AVATAR_COLORS, MAX_AVATAR_IMAGE_BYTES, randomAvatarColor } from "@/lib/bot-avatar";
import type { BotDto, ModelOption, PermissionRequestDto, ThinkingLevel, UiMessage } from "@/lib/types";

function textOf(message: UiMessage): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
}


export function BotView({ id }: { id: string }) {
  const [bot, setBot] = useState<BotDto | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [permission, setPermission] = useState<PermissionRequestDto | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [soul, setSoul] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingSoul, setSavingSoul] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [updatingThinking, setUpdatingThinking] = useState(false);
  const [updatingColor, setUpdatingColor] = useState(false);
  const [updatingImage, setUpdatingImage] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const router = useRouter();

  const load = useCallback(() => {
    return getJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`)
      .then((result) => {
        setBot(result.bot);
        setSoul(result.bot.soul);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました"));
  }, [id]);

  useEffect(() => { void load(); }, [load]);

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
          };
          if (payload.messages) setMessages(payload.messages);
          setPermission(payload.permissionRequest ?? null);
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

  const send = async () => {
    const value = prompt.trim();
    if (!value || sending) return;
    setPrompt("");
    setError(null);
    setSending(true);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(id)}/prompt`, { prompt: value });
    } catch (reason) {
      setSending(false);
      setError(reason instanceof Error ? reason.message : "リクエストに失敗しました");
    }
  };

  const respond = async (approved: boolean) => {
    if (!permission) return;
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(`bot:${id}`)}/permission`, { requestId: permission.id, approved });
      setPermission(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "権限リクエストに失敗しました"); }
  };

  const abort = async () => {
    try { await sendJson(`/api/bots/${encodeURIComponent(id)}/abort`, {}); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "リクエストに失敗しました"); }
  };

  const updateModel = async (value: string) => {
    if (!value || value === modelValue) return;
    setUpdatingModel(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { model: value }, "PATCH");
      setBot(result.bot);
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
      setBot(result.bot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "思考レベルの切替に失敗しました");
    } finally { setUpdatingThinking(false); }
  };

  const updateAvatarColor = async (color: string) => {
    if (color === bot?.avatarColor) return;
    setUpdatingColor(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { avatarColor: color }, "PATCH");
      setBot(result.bot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u8272\u306e\u5909\u66f4\u306b\u5931\u6557\u3057\u307e\u3057\u305f");
    } finally { setUpdatingColor(false); }
  };

  const updateAvatarImage = async (image: string | null) => {
    setUpdatingImage(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { avatarImage: image }, "PATCH");
      setBot(result.bot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "画像の変更に失敗しました");
    } finally { setUpdatingImage(false); }
  };

  const onAvatarFileChange = (file: File | null) => {
    if (!file) return;
    if (!file.type.match(/^image\/(png|jpeg|gif|webp)$/)) { window.alert("PNG・JPEG・GIF・WebP の画像を選択してください。"); return; }
    if (file.size > MAX_AVATAR_IMAGE_BYTES) { window.alert("2 MB以下の画像を選択してください。"); return; }
    const reader = new FileReader();
    reader.onload = () => { void updateAvatarImage(String(reader.result)); };
    reader.readAsDataURL(file);
  };

  const saveSoul = async () => {
    setSavingSoul(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { soul }, "PATCH");
      setBot(result.bot);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存に失敗しました"); }
    finally { setSavingSoul(false); }
  };

  const removeBot = async () => {
    if (!bot || deleting || !window.confirm(`「${bot.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await sendJson(`/api/bots/${encodeURIComponent(id)}`, undefined, "DELETE");
      router.push("/bots");
    } catch (reason) {
      setDeleting(false);
      setError(reason instanceof Error ? reason.message : "ボットの削除に失敗しました");
    }
  };

  const rendered = useMemo(() => messages.map((message) => {
    const user = message.role === "user";
    const text = textOf(message);
    if (!text && !message.error) return null;
    return (
      <div key={message.id} className={`flex items-end gap-2 ${user ? "justify-end" : "justify-start"}`}>
        {!user && <BotAvatar size={28} color={bot?.avatarColor} image={bot?.avatarImage} name={bot?.name} />}
        <div className={`max-w-[min(42rem,88%)] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${user ? "rounded-br-md bg-accent text-white" : "rounded-bl-md border border-border bg-surface"}`}>
          {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
          {message.error && <div className="mt-1 text-xs text-danger">{message.error}</div>}
        </div>
      </div>
    );
  }), [bot?.avatarColor, bot?.avatarImage, bot?.name, messages]);

  if (!bot) return <div className="p-5 text-sm text-muted">{error ?? "読み込み中…"}</div>;

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Link href="/bots" aria-label="ボット一覧へ戻る" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"><ArrowLeft className="h-4 w-4" /></Link>
        <BotAvatar size={36} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} />
        <div className="min-w-0 flex-1"><h1 className="truncate font-semibold">{bot.name}</h1><p className="text-xs text-muted">1:1 ボット</p></div>
        <button
          type="button"
          aria-expanded={settingsOpen}
          aria-controls="bot-settings-panel"
          onClick={() => setSettingsOpen((open) => !open)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
        >
          <Settings2 className="h-3.5 w-3.5" />設定
        </button>
        {sending && <Button size="sm" variant="ghost" onClick={() => void abort()}>停止</Button>}
      </header>


      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && !sending && <div className="rounded-2xl border border-dashed border-border bg-surface/50 px-5 py-8 text-center"><BotAvatar size={48} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} className="mx-auto mb-3" /><p className="font-medium">{bot.name} と話す</p><p className="mt-1 text-sm text-muted">メッセージを送って会話を始めましょう。</p></div>}
          {rendered}
          {permission && <div className="rounded-2xl border border-warning/40 bg-warning-bg p-4 text-xs"><p className="font-medium">権限の確認が必要です</p><p className="mt-1 break-all text-muted">{permission.message}</p><div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void respond(true)}>許可</Button><Button size="sm" variant="ghost" onClick={() => void respond(false)}>拒否</Button></div></div>}
          {sending && <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />応答中…</div>}
        </div>
      </main>

      <div className="shrink-0 border-t border-border bg-bg px-3 py-3">
        <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface px-3 py-2 shadow-sm focus-within:border-accent/60">
          <div className="flex items-end gap-2">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composingRef.current) { event.preventDefault(); void send(); } }} placeholder={`${bot.name}にメッセージ`} rows={1} className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-faint" />
            <button type="button" aria-label="添付または追加" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"><Plus className="h-4 w-4" /></button>
            {sending ? <Button onClick={() => void abort()} variant="danger">停止</Button> : <Button onClick={() => void send()} disabled={!prompt.trim()}>送信</Button>}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
            <button type="button" onClick={() => setSettingsOpen(true)} className="truncate hover:text-text">モデル: {selectedModel?.label ?? "未選択"}</button>
            <button type="button" onClick={() => setSettingsOpen(true)} className="shrink-0 hover:text-text">思考: {thinkingValue}</button>
          </div>
        </div>
        {error && <p role="alert" className="mx-auto mt-2 max-w-3xl text-xs text-danger">{error}</p>}
      </div>
      </div>

      {settingsOpen && (
        <aside id="bot-settings-panel" aria-label="ボット設定" className="flex h-full w-[min(100%,22rem)] shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
            <div><h2 className="font-semibold">ボット設定</h2><p className="mt-0.5 text-xs text-muted">このボットのプロフィールと応答を設定</p></div>
            <button type="button" aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            <div className="flex flex-col items-center gap-2 py-2">
              <label title="画像を設定" className="cursor-pointer rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent">
                <BotAvatar size={80} color={bot.avatarColor} image={bot.avatarImage} name={bot.name} />
                <input type="file" aria-label="ボットの画像を設定" accept={AVATAR_IMAGE_ACCEPT} disabled={updatingImage} className="sr-only" onChange={(event) => { onAvatarFileChange(event.target.files?.[0] ?? null); event.currentTarget.value = ""; }} />
              </label>
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted">タップして画像を設定</p>
                {bot.avatarImage && <button type="button" disabled={updatingImage} onClick={() => void updateAvatarImage(null)} className="text-xs text-danger hover:underline disabled:opacity-50">画像を削除</button>}
              </div>
            </div>
            <label className="block text-sm"><span className="font-medium">名前</span><div className="mt-2 rounded-xl border border-border bg-bg px-3 py-2.5">{bot.name}</div></label>
            <div className="rounded-2xl border border-border bg-bg p-4"><div className="flex items-center justify-between"><span className="text-sm font-medium">色</span><Button size="sm" variant="ghost" onClick={() => void updateAvatarColor(randomAvatarColor(bot.avatarColor))} busy={updatingColor}>ランダム</Button></div><div role="group" aria-label="ボットの色" className="mt-3 flex flex-wrap gap-2">{BOT_AVATAR_COLORS.map((color) => <button key={color} type="button" aria-label={color} aria-pressed={bot.avatarColor === color} disabled={updatingColor} onClick={() => void updateAvatarColor(color)} className={`h-8 w-8 rounded-full border-2 border-transparent transition-transform hover:scale-110 disabled:opacity-50 ${bot.avatarColor === color ? "border-text ring-2 ring-accent/30" : ""}`} style={{ backgroundColor: color }} />)}</div></div>
            <label className="block text-sm"><span className="font-medium">ラベル</span><div className="mt-2 rounded-xl border border-border bg-bg px-3 py-2.5 text-muted">1:1 アシスタント</div></label>
            <label className="block text-sm"><span className="font-medium">説明 / SOUL.md</span><textarea value={soul} onChange={(event) => setSoul(event.target.value)} rows={9} className="mt-2 w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-accent" /></label>
            <div className="space-y-3 rounded-2xl border border-border bg-bg p-4"><div><span className="text-sm font-medium">モデル</span><ModelSelect value={modelValue} options={models} loading={modelsLoading} disabled={updatingModel || updatingThinking} onChange={(value) => void updateModel(value)} className="mt-2 h-9 w-full" ariaLabel="ボットのモデル" /></div><div><span className="text-sm font-medium">思考レベル</span><ThinkingSelect levels={thinkingLevels} value={thinkingValue} disabled={updatingModel || updatingThinking} onChange={(value) => void updateThinking(value)} className="mt-2 h-9 w-full" /></div>{(updatingModel || updatingThinking) && <p className="text-xs text-muted">保存中…</p>}</div>
            <div className="flex justify-end"><Button size="sm" onClick={() => void saveSoul()} busy={savingSoul}>変更を保存</Button></div>
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
