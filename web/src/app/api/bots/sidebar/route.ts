import { NextResponse } from "next/server";
import { botTaskId, listBots } from "@/lib/bots";
import { listRooms } from "@/lib/rooms";
import { getTask } from "@/lib/store";
import { getTaskDetail } from "@/lib/pi/harness";
import type { UiMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Preview = { lastMessageSummary: string | null; lastMessageAt: string | null };
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }
function summarize(text: string): string { const compact = text.replace(/\s+/g, " ").trim(); return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact; }

export async function GET() {
  const bots = listBots();
  const botPreviews = await Promise.all(bots.map(async (bot) => {
    const task = getTask(botTaskId(bot.id));
    let preview: Preview = { lastMessageSummary: null, lastMessageAt: task?.updatedAt ?? null };
    try {
      if (task) {
        const detail = await getTaskDetail(task.id);
        const message = [...detail.messages].reverse().find((item) => item.role === "user" || item.role === "assistant");
        if (message) preview = { lastMessageSummary: summarize(textOf(message)) || null, lastMessageAt: new Date(message.createdAt).toISOString() };
      }
    } catch { /* sidebar preview is best effort */ }
    return { ...bot, ...preview };
  }));
  const rooms = listRooms().map((room) => {
    const message = room.messages[room.messages.length - 1];
    return { ...room, lastMessageSummary: message ? summarize(message.text) || null : null, lastMessageAt: message ? new Date(message.createdAt).toISOString() : room.updatedAt };
  });
  return NextResponse.json({ bots: botPreviews, rooms });
}
