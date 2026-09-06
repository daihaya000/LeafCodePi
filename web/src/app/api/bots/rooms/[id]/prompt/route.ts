import { NextRequest, NextResponse } from "next/server";
import { appendRoomMessage, botsForRoomPrompt, ensureRoomBotTask, getRoom, updateRoomMessage } from "@/lib/rooms";
import { getTaskDetail, jsonError, promptTask, subscribeTask } from "@/lib/pi/harness";
import type { UiMessage } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }
function latestAssistant(messages: UiMessage[], since: number): UiMessage | undefined { return [...messages].reverse().find((message) => message.role === "assistant" && message.createdAt >= since - 2_000); }
async function runRoomBot(roomId: string, taskId: string, prompt: string, since: number, responseId: string) {
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const finish = async () => {
    if (closed) return;
    try {
      const detail = await getTaskDetail(taskId);
      if (detail.isStreaming) return;
      const assistant = latestAssistant(detail.messages, since);
      updateRoomMessage(roomId, responseId, assistant ? { text: textOf(assistant), status: "done" } : { text: detail.error || "Bot did not return a response.", status: "error" });
      closed = true; unsubscribe();
    } catch (error) {
      updateRoomMessage(roomId, responseId, { text: error instanceof Error ? error.message : String(error), status: "error" });
      closed = true; unsubscribe();
    }
  };
  unsubscribe = subscribeTask(taskId, (payload) => { if (payload.type === "snapshot") void finish(); });
  try { await promptTask(taskId, prompt); await finish(); } catch (error) {
    updateRoomMessage(roomId, responseId, { text: error instanceof Error ? error.message : String(error), status: "error" });
    closed = true; unsubscribe();
  }
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    const room = getRoom(id);
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as { prompt?: unknown; broadcast?: unknown; fromBot?: unknown } | null;
    if (body?.fromBot === true) return NextResponse.json({ error: "Bot-to-bot relay is disabled" }, { status: 400 });
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    const prompt = body.prompt.trim();
    const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
    if (!userMessage) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const routed = botsForRoomPrompt(room, prompt, body.broadcast === true);
    const responses = routed.bots.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" })).filter((item): item is NonNullable<typeof item> => Boolean(item));
    for (const [index, bot] of routed.bots.entries()) { const response = responses[index]; if (response) void runRoomBot(id, ensureRoomBotTask(room, bot), prompt, userMessage.createdAt, response.id); }
    return NextResponse.json({ room: getRoom(id), routedBotIds: routed.bots.map((bot) => bot.id), broadcast: routed.broadcast });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}