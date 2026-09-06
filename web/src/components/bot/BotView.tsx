"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Settings2 } from "lucide-react";
import { getJson, sendJson } from "@/lib/client";
import { ModelSelect, modelOptionForValue } from "@/components/ModelSelect";
import { ThinkingSelect } from "@/components/ThinkingSelect";
import { Button } from "@/components/ui";
import type { BotDto, ModelOption, PermissionRequestDto, ThinkingLevel, UiMessage } from "@/lib/types";

function textOf(message: UiMessage): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function botInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "B";
}

export function BotView({ id }: { id: string }) {
  const [bot, setBot] = useState<BotDto | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [permission, setPermission] = useState<PermissionRequestDto | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [soul, setSoul] = useState("");
  const [sending, setSending] = useState(false);
  const [savingSoul, setSavingSoul] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const [updatingThinking, setUpdatingThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);

  const load = useCallback(() => {
    return getJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`)
      .then((result) => {
        setBot(result.bot);
        setSoul(result.bot.soul);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Load failed"));
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
        } catch { setError("Could not parse event"); }
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
      setError(reason instanceof Error ? reason.message : "Request failed");
    }
  };

  const respond = async (approved: boolean) => {
    if (!permission) return;
    try {
      await sendJson(`/api/tasks/${encodeURIComponent(`bot:${id}`)}/permission`, { requestId: permission.id, approved });
      setPermission(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Permission request failed"); }
  };

  const abort = async () => {
    try { await sendJson(`/api/bots/${encodeURIComponent(id)}/abort`, {}); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed"); }
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

  const saveSoul = async () => {
    setSavingSoul(true);
    setError(null);
    try {
      const result = await sendJson<{ bot: BotDto }>(`/api/bots/${encodeURIComponent(id)}`, { soul }, "PATCH");
      setBot(result.bot);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed"); }
    finally { setSavingSoul(false); }
  };

  const rendered = useMemo(() => messages.map((message) => {
    const user = message.role === "user";
    const text = textOf(message);
    if (!text && !message.error) return null;
    return (
      <div key={message.id} className={`flex items-end gap-2 ${user ? "justify-end" : "justify-start"}`}>
        {!user && <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{botInitial(bot?.name ?? "Bot")}</div>}
        <div className={`max-w-[min(42rem,88%)] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${user ? "rounded-br-md bg-accent text-white" : "rounded-bl-md border border-border bg-surface"}`}>
          {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
          {message.error && <div className="mt-1 text-xs text-danger">{message.error}</div>}
        </div>
      </div>
    );
  }), [bot?.name, messages]);

  if (!bot) return <div className="p-5 text-sm text-muted">{error ?? "Loading"}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="relative flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Link href="/bots" aria-label="ボット一覧へ戻る" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent">{botInitial(bot.name)}</div>
        <div className="min-w-0 flex-1"><h1 className="truncate font-semibold">{bot.name}</h1><p className="text-xs text-muted">1:1 Bot</p></div>
        <details className="relative shrink-0">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"><Settings2 className="h-3.5 w-3.5" />設定</summary>
          <div className="absolute right-0 top-full z-20 mt-2 w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-4 shadow-xl">
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Bot settings</h2><span className="text-xs text-muted">SOUL.md</span></div>
            <textarea value={soul} onChange={(event) => setSoul(event.target.value)} rows={9} className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent" />
            <div className="mt-3 flex justify-end"><Button size="sm" onClick={() => void saveSoul()} busy={savingSoul}>Save SOUL</Button></div>
          </div>
        </details>
        {sending && <Button size="sm" variant="ghost" onClick={() => void abort()}>Stop</Button>}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && !sending && <div className="rounded-2xl border border-dashed border-border bg-surface/50 px-5 py-8 text-center"><div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-lg font-semibold text-accent">{botInitial(bot.name)}</div><p className="font-medium">{bot.name} と話す</p><p className="mt-1 text-sm text-muted">メッセージを送って会話を始めましょう。</p></div>}
          {rendered}
          {permission && <div className="rounded-2xl border border-warning/40 bg-warning-bg p-4 text-xs"><p className="font-medium">Permission required</p><p className="mt-1 break-all text-muted">{permission.message}</p><div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void respond(true)}>Allow</Button><Button size="sm" variant="ghost" onClick={() => void respond(false)}>Deny</Button></div></div>}
          {sending && <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />Responding…</div>}
        </div>
      </main>

      <div className="shrink-0 border-t border-border bg-bg px-3 py-3">
        <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-surface px-3 py-2 shadow-sm focus-within:border-accent/60">
          <div className="flex items-end gap-2">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composingRef.current) { event.preventDefault(); void send(); } }} placeholder="Message the bot" rows={1} className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-faint" />
            {sending ? <Button onClick={() => void abort()} variant="danger">Stop</Button> : <Button onClick={() => void send()} disabled={!prompt.trim()}>Send</Button>}
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/70 pt-2">
            <span className="text-[11px] font-medium text-muted">Model</span>
            <ModelSelect value={modelValue} options={models} loading={modelsLoading} disabled={updatingModel || updatingThinking} onChange={(value) => void updateModel(value)} className="h-8 min-w-0 max-w-full flex-1 md:max-w-xs" ariaLabel="Bot model" />
            <ThinkingSelect levels={thinkingLevels} value={thinkingValue} disabled={updatingModel || updatingThinking} onChange={(value) => void updateThinking(value)} className="h-8 w-auto shrink-0" />
            {(updatingModel || updatingThinking) && <span className="text-[11px] text-muted">Saving…</span>}
          </div>
        </div>
        {error && <p role="alert" className="mx-auto mt-2 max-w-3xl text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
