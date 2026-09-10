import { NextResponse } from "next/server";
import { botTaskId, listBots } from "@/lib/bots";
import { listRooms } from "@/lib/rooms";
import { getTask, listTasks } from "@/lib/store";
import { readSessionLastMessage } from "@/lib/direct-session";
import { listBotCodeRequests } from "@/lib/pi/bot-code-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Preview = { lastMessageSummary: string | null; lastMessageAt: string | null };
function summarize(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
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
    if (task.status === "working" && task.botId) counts.set(task.botId, (counts.get(task.botId) ?? 0) + 1);
  }
  const bots = listBots();
  const botPreviews = bots.map((bot) => {
    const task = getTask(botTaskId(bot.id));
    let preview: Preview = { lastMessageSummary: null, lastMessageAt: null };
    if (task) {
      // プレビューはセッションファイルのオフライン読取のみ。getTaskDetail
      // （ensureLive）は Pi ランタイムをBot数分初期化するため、初回表示が
      // 十数秒待たされる原因になる。ライブ詳細は Bot を開いた画面が担う。
      const last = readSessionLastMessage(task.sessionFile);
      const at = safeIso(last?.timestamp);
      if (last && at !== null) {
        preview = {
          lastMessageSummary: summarize(last.text) || null,
          lastMessageAt: at,
        };
      }
    }
    const codeInProgress = listBotCodeRequests(bot.id).some((request) => request.state === "starting" || request.state === "running");
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
