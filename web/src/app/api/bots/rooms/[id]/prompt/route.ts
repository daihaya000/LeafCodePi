import { NextRequest, NextResponse } from "next/server";
import { appendRoomMessage, botsForRoomPrompt, consumeRoomRelayEnvelope, ensureRoomBotTask, getRoom, roomBotTaskId, updateRoomMessage } from "@/lib/rooms";
import { getBot } from "@/lib/bots";
import { getTaskDetail, jsonError, promptTask } from "@/lib/pi/harness";
import type { BotDto, RoomDto, RoomMessage, UiMessage } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One outstanding reply per room/bot; different bots and rooms still run in parallel.
const roomBotRuns = new Map<string, Promise<void>>();
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }

async function runRoomBot(room: RoomDto, bot: BotDto, prompt: string, responseId: string) {
  const taskId = roomBotTaskId(room.id, bot.id);
  const previous = roomBotRuns.get(taskId);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  roomBotRuns.set(taskId, current);
  try {
    await previous;
    if (!getRoom(room.id)) return;
    ensureRoomBotTask(room, bot);
    const before = new Set((await getTaskDetail(taskId)).messages.map((message) => message.id));
    // Acceptance/routing snapshots can be non-streaming before generation starts.
    // Wait for this queue entry instead of inferring completion from UI snapshots.
    await promptTask(taskId, prompt, undefined, { waitForCompletion: true });
    const detail = await getTaskDetail(taskId);
    const assistant = [...detail.messages].reverse().find((message) => message.role === "assistant" && !before.has(message.id));
    const error = detail.error || assistant?.error;
    const text = assistant ? textOf(assistant) : "";
    updateRoomMessage(room.id, responseId, { text: error || (text.trim() ? text : "Bot did not return a response."), status: error || !text.trim() ? "error" : "done" });
  } catch (error) {
    updateRoomMessage(room.id, responseId, { text: error instanceof Error ? error.message : String(error), status: "error" });
  } finally {
    release();
    if (roomBotRuns.get(taskId) === current) roomBotRuns.delete(taskId);
  }
}

type PromptBody = { prompt?: unknown; broadcast?: unknown; fromBot?: unknown; relayEnvelope?: unknown };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    const room = getRoom(id);
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const body = (await req.json().catch(() => null)) as PromptBody | null;
    const isRelayRequest = body?.fromBot === true || body?.relayEnvelope !== undefined;
    if (isRelayRequest) {
      if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
      // Only a server-issued, single-use envelope can establish source, targets, depth, and turn.
      const envelope = typeof body.relayEnvelope === "string" ? consumeRoomRelayEnvelope(id, body.relayEnvelope) : undefined;
      if (!envelope) return NextResponse.json({ error: "A valid server relay envelope is required" }, { status: 403 });
      const prompt = body.prompt.trim();
      const userMessage = appendRoomMessage(id, { role: "user", text: prompt, sourceBotId: envelope.sourceBotId, relayTurnId: envelope.turnId, relayDepth: envelope.depth });
      if (!userMessage) return NextResponse.json({ error: "Room not found" }, { status: 404 });
      const targets = envelope.targetBotIds.map((botId) => getBot(botId)).filter((bot): bot is BotDto => Boolean(bot));
      const responses = targets.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working", sourceBotId: envelope.sourceBotId, relayTurnId: envelope.turnId, relayDepth: envelope.depth, relayParentMessageId: userMessage.id })).filter((item): item is RoomMessage => Boolean(item));
      for (const [index, bot] of targets.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id); }
      return NextResponse.json({ room: getRoom(id), routedBotIds: targets.map((bot) => bot.id), relay: true, relayDepth: envelope.depth, relayTurnId: envelope.turnId });
    }
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    const prompt = body.prompt.trim();
    const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
    if (!userMessage) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    const routed = botsForRoomPrompt(room, prompt, body.broadcast === true);
    const responses = routed.bots.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" })).filter((item): item is NonNullable<typeof item> => Boolean(item));
    for (const [index, bot] of routed.bots.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id); }
    return NextResponse.json({ room: getRoom(id), routedBotIds: routed.bots.map((bot) => bot.id), broadcast: routed.broadcast });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}