import { NextResponse } from "next/server";
import { botTaskId, listBots } from "@/lib/bots";
import { listRooms } from "@/lib/rooms";
import { getTask, listTasks } from "@/lib/store";
import { createSessionPreviewBudget, readSessionLastMessage } from "@/lib/direct-session";
import { listBotCodeRequestsForBots } from "@/lib/pi/bot-code-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Preview = { lastMessageSummary: string | null; lastMessageAt: string | null };
/** 80文字の要約に必要な範囲より十分長い先頭だけを正規化する（巨大な返信全体を毎回走査しない）。 */
const SUMMARY_SOURCE_CHARS = 4_000;
function summarize(text: string): string {
  const compact = text.slice(0, SUMMARY_SOURCE_CHARS).replace(/\s+/g, " ").trim();
  // コードポイント単位で切る（絵文字などのサロゲートペアを壊さない）。
  const chars = Array.from(compact);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : compact;
}
function safeIso(createdAt: number | undefined): string | null {
  const at = new Date(createdAt ?? Number.NaN).getTime();
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export async function GET() {
  const counts = new Map<string, number>();
  for (const task of listTasks()) {
    const botId = task.botId ?? task.supervisorBotId;
    if (task.status === "working" && botId) counts.set(botId, (counts.get(botId) ?? 0) + 1);
  }
  const bots = listBots();
  // One outbox read for every Bot: each listBotCodeRequests() call would enumerate
  // the directory again, and the sidebar asks for all of them on every refresh.
  const requestsByBot = listBotCodeRequestsForBots(bots.map((bot) => bot.id));
  // Hard poll budget (114): skip previews once bytes/files are exhausted.
  const previewBudget = createSessionPreviewBudget();
  const botPreviews = bots.map((bot) => {
    const task = getTask(botTaskId(bot.id));
    let preview: Preview = { lastMessageSummary: null, lastMessageAt: null };
    if (task) {
      // プレビューはセッションファイルのオフライン読取のみ。getTaskDetail
      // （ensureLive）は Pi ランタイムをBot数分初期化するため、初回表示が
      // 十数秒待たされる原因になる。ライブ詳細は Bot を開いた画面が担う。
      const last = readSessionLastMessage(task.sessionFile, previewBudget);
      const at = safeIso(last?.timestamp);
      if (last && at !== null) {
        preview = {
          lastMessageSummary: summarize(last.text) || null,
          lastMessageAt: at,
        };
      }
    }
    const codeInProgress = (requestsByBot.get(bot.id) ?? []).some((request) => request.state === "starting" || request.state === "running");
    return { ...bot, ...preview, codeInProgress, codeSessionCount: counts.get(bot.id) ?? 0 };
  });
  const rooms = listRooms().map((room) => {
    const message = room.messages[room.messages.length - 1];
    return {
      ...room,
      lastMessageSummary: message ? summarize(message.text) || null : null,
      lastMessageAt: message ? safeIso(message.createdAt) : null,
    };
  });
  return NextResponse.json({ bots: botPreviews, rooms });
}
