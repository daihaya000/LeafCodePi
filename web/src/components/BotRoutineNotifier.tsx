"use client";

import { useEffect } from "react";
import { getBotSidebarSnapshot, refreshBotSidebar } from "@/lib/bot-sidebar-store";
import { isRoutineRunShownInline, routineRunNotificationText } from "@/lib/notify";
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
  if (isRoutineRunShownInline(window.location.pathname, run.botId)) return;
  const findBot = () => getBotSidebarSnapshot().bots.find((item) => item.id === run.botId);
  const bot = findBot();
  if (bot) {
    deliverRoutineRunNotification(run, bot.notificationsEnabled === false);
    return;
  }
  // サイドバー未取得（取得前・失敗）の間にミュート中の Bot が鳴らないよう、一度だけ取得してから判定する。
  // 取得に失敗した場合のみ既定（通知あり）に従う。
  void refreshBotSidebar()
    .catch(() => undefined)
    .then(() => {
      if (isRoutineRunShownInline(window.location.pathname, run.botId)) return;
      deliverRoutineRunNotification(run, findBot()?.notificationsEnabled === false);
    });
}

function deliverRoutineRunNotification(run: RoutineRunEventDto, muted: boolean): void {
  // 通知を切っているBotは鳴らさない。
  if (muted) return;

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
