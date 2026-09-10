import { NextResponse } from "next/server";
import { botTaskId, listBots } from "@/lib/bots";
import { listRooms } from "@/lib/rooms";
import { getTask, listTasks } from "@/lib/store";
import { getTaskDetail } from "@/lib/pi/harness";
import { listBotCodeRequests } from "@/lib/pi/bot-code-relay";
import type { UiMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Preview = { lastMessageSummary: string | null; lastMessageAt: string | null };
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }
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
  const botPreviews = await Promise.all(bots.map(async (bot) => {
    const task = getTask(botTaskId(bot.id));
    let preview: Preview = { lastMessageSummary: null, lastMessageAt: null };
    try {
      if (task) {
        const detail = await getTaskDetail(task.id);
        const message = [...detail.messages].reverse().find((item) => item.role === "user" || item.role === "assistant");
        if (message) {
          const at = safeIso(message.createdAt);
          if (at !== null) {
            preview = {
              lastMessageSummary: summarize(textOf(message)) || null,
              lastMessageAt: at,
            };
          }
        }
      }
    } catch { /* sidebar preview is best effort */ }
    const codeInProgress = listBotCodeRequests(bot.id).some((request) => request.state === "starting" || request.state === "running");
    return { ...bot, ...preview, codeInProgress, codeSessionCount: counts.get(bot.id) ?? 0 };
  }));
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
