import { NextRequest, NextResponse } from "next/server";
import { appendRoomMessage, botsForRoomPrompt, consumeRoomRelayEnvelope, getRoom, saveRoomImages, updateRoomMessage } from "@/lib/rooms";
import { getBot } from "@/lib/bots";
import { isPromptImageList } from "@/lib/prompt-images";
import { jsonError } from "@/lib/pi/harness";
import { isRoomConversationRequest, isRoomStopRequest, MAX_ROOM_CONVERSATION_PARTICIPANTS } from "@/lib/room-conversation";
import { runRoomBot, runRoomConversation, runRoomFanOut, settleStaleRoomTurns, steerRoomTurns, stopRoomTurns } from "@/lib/room-runtime";
import type { BotDto, RoomMessage } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PromptBody = { prompt?: unknown; broadcast?: unknown; fromBot?: unknown; relayEnvelope?: unknown; images?: unknown };

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
    if (typeof body?.prompt !== "string") return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    // Attachments only ever come from the user composer, never from a relayed bot payload.
    if (body.images !== undefined && !isPromptImageList(body.images)) return NextResponse.json({ error: "invalid images" }, { status: 400 });
    const attachments = body.images ?? [];
    if (!body.prompt.trim() && attachments.length === 0) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    const prompt = body.prompt.trim();
    settleStaleRoomTurns(id);
    const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
    if (!userMessage) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    // ponytail: attachment files outlive a revert; the whole directory goes when the room is deleted.
    if (attachments.length > 0) {
      const saved = saveRoomImages(id, userMessage.id, attachments);
      if (saved.length > 0) updateRoomMessage(id, userMessage.id, { images: saved });
    }
    if (isRoomStopRequest(prompt)) {
      const stopped = await stopRoomTurns(id);
      return NextResponse.json({ room: getRoom(id), routedBotIds: [], stopped: true, stoppedTurns: stopped });
    }
    // A new instruction redirects the turns already being written; those bots answer once, there.
    const steered = new Set(await steerRoomTurns(id, prompt));
    const naturalRoomMessage = !prompt.includes("@") && body.broadcast !== true;
    const conversation = naturalRoomMessage || isRoomConversationRequest(prompt);
    let routed = botsForRoomPrompt(room, prompt, body.broadcast === true);
    if (conversation && routed.bots.length === 0 && !prompt.includes("@")) routed = botsForRoomPrompt(room, prompt, true);
    const pending = routed.bots.filter((bot) => !steered.has(bot.id));
    if (conversation && pending.length > 1) {
      const participants = [...pending].sort((a, b) => room.members.indexOf(a.id) - room.members.indexOf(b.id)).slice(0, MAX_ROOM_CONVERSATION_PARTICIPANTS);
      void runRoomConversation(room, participants, prompt, userMessage.id).catch(() => console.error("Room conversation failed"));
      return NextResponse.json({ room: getRoom(id), routedBotIds: participants.map((bot) => bot.id), steeredBotIds: [...steered], broadcast: routed.broadcast });
    }
    const responses = pending.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" })).filter((item): item is NonNullable<typeof item> => Boolean(item));
    void runRoomFanOut(room, pending, prompt, responses.map((response) => response.id), userMessage.id).catch(() => console.error("Room fan-out failed"));
    return NextResponse.json({ room: getRoom(id), routedBotIds: pending.map((bot) => bot.id), steeredBotIds: [...steered], broadcast: routed.broadcast });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
