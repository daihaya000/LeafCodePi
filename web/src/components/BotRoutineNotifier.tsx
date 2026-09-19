"use client";

import { useEffect } from "react";
import { getBotSidebarSnapshot } from "@/lib/bot-sidebar-store";
import { isRoutineRunHandledInline, routineRunNotificationText } from "@/lib/notify";
import { playSessionCompleteSound } from "@/lib/session-complete-sound";
import { sseReconnectDelayMs } from "@/lib/sse-reconnect";
import { BOT_ROUTINE_RUN_EVENT, type RoutineRunEventDto } from "@/lib/types";

/** 許可ダイアログは1ページに1回だけ出す（連続で出すとブラウザに無視される）。 */
let permissionRequested = false;

/**
 * ルーティンの完了を、開いている画面に関係なく知らせる。
 *
 * ルーティンはサーバーのスケジューラが走らせるため、BotView を開いていない
 * （Codeタブや別アプリを見ている）ときは完了に気づけなかった。全体 SSE を購読して
 * Bot 完了音（設定で Code と別の音を選べる）とデスクトップ通知を出す。
 * Bot タブを開いている画面では BotView が担当するので、ここでは何もしない。
 */
export function notifyRoutineRun(run: RoutineRunEventDto): void {
  if (isRoutineRunHandledInline(window.location.pathname, run.botId)) return;
  // 通知を切っているBotは鳴らさない。サイドバー未取得のBotは既定（通知あり）に従う。
  const bot = getBotSidebarSnapshot().bots.find((item) => item.id === run.botId);
  if (bot && bot.notificationsEnabled === false) return;

  playSessionCompleteSound("bot");

  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default" && !document.hidden && !permissionRequested) {
    // 初回だけ許可を尋ねる。この実行の通知は次回以降に任せる。
    permissionRequested = true;
    try {
      void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
    } catch {
      /* 非対応コンテキストは無視 */
    }
    return;
  }
  // 見えているタブでは音だけで足りる（他の画面の通知と同じ扱い）。
  if (Notification.permission !== "granted" || !document.hidden) return;

  const { title, body } = routineRunNotificationText(run);
  try {
    new Notification(title, { body, tag: `routine-${run.botId}` });
  } catch {
    /* 生成エラー（非対応コンテキスト等）は無視。 */
  }
}

function subscribeRoutineRuns(listener: (run: RoutineRunEventDto) => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const onRoutine: EventListener = (event) => {
    let run: RoutineRunEventDto;
    try {
      run = JSON.parse(String((event as MessageEvent).data)) as RoutineRunEventDto;
    } catch {
      return; // 壊れたイベントは無視する（次の実行でまた届く）。
    }
    if (typeof run?.botId !== "string") return;
    listener(run);
  };

  const open = () => {
    if (stopped) return;
    const next = new EventSource(`/api/bots/events?epoch=${Date.now()}`);
    source = next;
    next.addEventListener("open", () => { attempt = 0; });
    next.addEventListener(BOT_ROUTINE_RUN_EVENT, onRoutine);
    // 接続が恒久的に失敗した場合（サーバー再起動中など）は EventSource が
    // 再接続しないので、自前で張り直す。黙って通知が止まるのを避ける。
    next.addEventListener("error", () => {
      if (stopped || source !== next) return;
      next.close();
      source = null;
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, sseReconnectDelayMs(attempt));
    });
  };
  open();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    source?.close();
    source = null;
  };
}

export function BotRoutineNotifier() {
  useEffect(() => subscribeRoutineRuns(notifyRoutineRun), []);
  return null;
}
