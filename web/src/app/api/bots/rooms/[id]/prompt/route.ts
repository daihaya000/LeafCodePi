import { NextRequest, NextResponse } from "next/server";
import { appendRoomMessage, botsForRoomPrompt, consumeRoomRelayEnvelope, getRoom } from "@/lib/rooms";
import { getBot } from "@/lib/bots";
import { jsonError } from "@/lib/pi/harness";
import { isRoomConversationRequest, isRoomStopRequest, MAX_ROOM_CONVERSATION_PARTICIPANTS } from "@/lib/room-conversation";
import { runRoomBot, runRoomConversation, settleStaleRoomTurns } from "@/lib/room-runtime";
import type { BotDto, RoomMessage } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      for (const [index, bot] of targets.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id, userMessage.id); }
      return NextResponse.json({ room: getRoom(id), routedBotIds: targets.map((bot) => bot.id), relay: true, relayDepth: envelope.depth, relayTurnId: envelope.turnId });
    }
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    const prompt = body.prompt.trim();
    settleStaleRoomTurns(id);
    const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
    if (!userMessage) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    if (isRoomStopRequest(prompt)) return NextResponse.json({ room: getRoom(id), routedBotIds: [], stopped: true });
    const naturalRoomMessage = !prompt.includes("@") && body.broadcast !== true;
    const conversation = naturalRoomMessage || isRoomConversationRequest(prompt);
    let routed = botsForRoomPrompt(room, prompt, body.broadcast === true);
    if (conversation && routed.bots.length === 0 && !prompt.includes("@")) routed = botsForRoomPrompt(room, prompt, true);
    if (conversation && routed.bots.length > 1) {
      const participants = [...routed.bots].sort((a, b) => room.members.indexOf(a.id) - room.members.indexOf(b.id)).slice(0, MAX_ROOM_CONVERSATION_PARTICIPANTS);
      void runRoomConversation(room, participants, prompt, userMessage.id).catch(() => console.error("Room conversation failed"));
      return NextResponse.json({ room: getRoom(id), routedBotIds: routed.bots.map((bot) => bot.id), broadcast: routed.broadcast });
    }
    const responses = routed.bots.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" })).filter((item): item is NonNullable<typeof item> => Boolean(item));
    for (const [index, bot] of routed.bots.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id, userMessage.id); }
    return NextResponse.json({ room: getRoom(id), routedBotIds: routed.bots.map((bot) => bot.id), broadcast: routed.broadcast });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
