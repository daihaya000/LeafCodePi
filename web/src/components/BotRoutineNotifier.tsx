"use client";

import { useEffect } from "react";
import { getBotSidebarSnapshot } from "@/lib/bot-sidebar-store";
import { isRoutineRunHandledInline, routineRunNotificationText } from "@/lib/notify";
import { getNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";
import { playSessionCompleteSound } from "@/lib/session-complete-sound";
import { subscribeBotsEvents } from "@/lib/bots-events-hub";
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

  if (!getNotificationDeliveryEnabled() || typeof Notification === "undefined") return;
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
  // The shared tab-wide source owns reconnect/backoff; malformed frames are dropped here.
  return subscribeBotsEvents({
    events: {
      [BOT_ROUTINE_RUN_EVENT]: (payload) => {
        const run = payload as RoutineRunEventDto | undefined;
        if (typeof run?.botId !== "string") return;
        listener(run);
      },
    },
  });
}

export function BotRoutineNotifier() {
  useEffect(() => subscribeRoutineRuns(notifyRoutineRun), []);
  return null;
}
