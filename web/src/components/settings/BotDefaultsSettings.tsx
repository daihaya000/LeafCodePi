"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "@/lib/client";
import {
  BOT_DEFAULT_PERMISSION_KEY,
  BOT_DEFAULT_THINKING_KEY,
  parseBotDefaultPermission,
  parseBotDefaultThinking,
  type BotDefaultPermission,
} from "@/lib/bot-settings";
import type { ThinkingLevel } from "@/lib/types";

export function BotDefaultsSettings() {
  const [permission, setPermission] = useState<BotDefaultPermission>("ask");
  const [thinking, setThinking] = useState<ThinkingLevel>("off");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const reload = useCallback(async () => {
    try {
      const [permissionResult, thinkingResult] = await Promise.all([
        getJson<{ value: string | null }>(`/api/settings/${BOT_DEFAULT_PERMISSION_KEY}`),
        getJson<{ value: string | null }>(`/api/settings/${BOT_DEFAULT_THINKING_KEY}`),
      ]);
      setPermission(parseBotDefaultPermission(permissionResult.value));
      setThinking(parseBotDefaultThinking(thinkingResult.value));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "\u30dc\u30c3\u30c8\u8a2d\u5b9a\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  async function save(key: string, value: string) {
    try { await sendJson(`/api/settings/${key}`, { value }, "PUT"); setError(null); setSaved(true); window.setTimeout(() => setSaved(false), 1500); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "\u30dc\u30c3\u30c8\u8a2d\u5b9a\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f"); }
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="rounded-2xl border border-border bg-surface p-4 text-sm">
        <span className="font-medium">権限の既定値</span>
        <select value={permission} onChange={(event) => { const value = event.target.value as BotDefaultPermission; setPermission(value); void save(BOT_DEFAULT_PERMISSION_KEY, value); }} className="mt-2 h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm">
          <option value="allow">許可</option><option value="ask">確認する</option><option value="deny">拒否</option>
        </select>
        <span className="mt-1 block text-xs text-muted">新しく作るBotのツール権限に適用します。</span>
      </label>
      <label className="rounded-2xl border border-border bg-surface p-4 text-sm">
        <span className="font-medium">思考レベルの既定値</span>
        <select value={thinking} onChange={(event) => { const value = event.target.value as ThinkingLevel; setThinking(value); void save(BOT_DEFAULT_THINKING_KEY, value); }} className="mt-2 h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm">
          {(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <span className="mt-1 block text-xs text-muted">新規Bot作成時に実際のセッションへ接続されます。</span>
      </label>
      {saved && <p className="sm:col-span-2 text-xs text-success" role="status">保存しました</p>}
      {error && <p className="sm:col-span-2 text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}
