import { NextRequest, NextResponse } from "next/server";
import { appendRoomMessage, botsForRoomPrompt, consumeRoomRelayEnvelope, ensureRoomBotTask, getRoom, roomBotTaskId, updateRoomMessage } from "@/lib/rooms";
import { getBot } from "@/lib/bots";
import { getTaskDetail, jsonError, promptTask } from "@/lib/pi/harness";
import type { BotDto, RoomDto, RoomMessage, UiMessage } from "@/lib/types";
import { isRoomConversationRequest, latestRoomRequest, MAX_ROOM_CONVERSATION_TURNS, parseRoomReply, roomBotPrompt, type RoomReply, type RoomTurn } from "@/lib/room-conversation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One outstanding reply per room/bot; different bots and rooms still run in parallel.
const roomBotRuns = new Map<string, Promise<void>>();
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }

async function runRoomBot(room: RoomDto, bot: BotDto, prompt: string, responseId: string, requestId: string, turn?: RoomTurn): Promise<RoomReply | undefined> {
  const taskId = roomBotTaskId(room.id, bot.id);
  const previous = roomBotRuns.get(taskId);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  roomBotRuns.set(taskId, current);
  try {
    await previous;
    const liveRoom = getRoom(room.id);
    if (!liveRoom) return;
    if (turn && latestRoomRequest(liveRoom)?.id !== requestId) {
      updateRoomMessage(room.id, responseId, { text: "Conversation superseded by a newer user message.", status: "done" });
      return;
    }
    if (!liveRoom.members.includes(bot.id) || !getBot(bot.id)?.enabled) {
      updateRoomMessage(room.id, responseId, { text: "Bot is no longer active in this room.", status: "error" });
      return;
    }
    ensureRoomBotTask(liveRoom, bot);
    const before = new Set((await getTaskDetail(taskId)).messages.map((message) => message.id));
    // Acceptance/routing snapshots can be non-streaming before generation starts.
    // Wait for this queue entry instead of inferring completion from UI snapshots.
    const currentRoom = getRoom(room.id);
    if (!currentRoom) return;
    if (turn && latestRoomRequest(currentRoom)?.id !== requestId) {
      updateRoomMessage(room.id, responseId, { text: "Conversation superseded by a newer user message.", status: "done" });
      return;
    }
    if (!currentRoom.members.includes(bot.id) || !getBot(bot.id)?.enabled) {
      updateRoomMessage(room.id, responseId, { text: "Bot is no longer active in this room.", status: "error" });
      return;
    }
    const participants = (turn?.participants ?? currentRoom.members.map(getBot).filter((member): member is BotDto => Boolean(member)))
      .filter((member) => currentRoom.members.includes(member.id) && getBot(member.id)?.enabled);
    const context = roomBotPrompt(currentRoom, bot, participants, prompt, requestId, turn);
    await promptTask(taskId, context, undefined, { waitForCompletion: true });
    const detail = await getTaskDetail(taskId);
    const assistant = [...detail.messages].reverse().find((message) => message.role === "assistant" && !before.has(message.id));
    const error = detail.error || assistant?.error;
    const raw = assistant ? textOf(assistant) : "";
    const reply = turn ? parseRoomReply(raw, bot.id, participants) : { text: raw };
    const { text } = reply;
    updateRoomMessage(room.id, responseId, { text: error || (text.trim() ? text : "Bot did not return a response."), status: error || !text.trim() ? "error" : "done" });
    return error || !text.trim() ? undefined : reply;
  } catch (error) {
    updateRoomMessage(room.id, responseId, { text: error instanceof Error ? error.message : String(error), status: "error" });
  } finally {
    release();
    if (roomBotRuns.get(taskId) === current) roomBotRuns.delete(taskId);
  }
}

async function runRoomConversation(room: RoomDto, bots: BotDto[], prompt: string, userMessageId: string) {
  const maxTurns = Math.min(MAX_ROOM_CONVERSATION_TURNS, bots.length * 3);
  const spoken = new Set<string>();
  const replies = new Map<string, Set<string>>();
  let nextBotId = bots[0]?.id;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const current = getRoom(room.id);
    if (!current || latestRoomRequest(current)?.id !== userMessageId) return;
    const active = bots.filter((bot) => current.members.includes(bot.id) && getBot(bot.id)?.enabled);
    if (active.length < 2) return;
    const bot = active.find((member) => member.id === nextBotId) ?? active.find((member) => !spoken.has(member.id)) ?? active[0];
    const response = appendRoomMessage(room.id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" });
    if (!response) return;
    const reply = await runRoomBot(room, bot, prompt, response.id, userMessageId, { participants: active, turn, maxTurns });
    if (!reply) return;
    spoken.add(bot.id);
    const normalized = reply.text.trim().replace(/\s+/g, " ");
    const previous = replies.get(bot.id) ?? new Set<string>();
    if (previous.has(normalized)) return;
    previous.add(normalized);
    replies.set(bot.id, previous);
    const unheard = active.filter((member) => !spoken.has(member.id));
    if (reply.action === "done" && unheard.length === 0) return;
    // ponytail: models ignoring the protocol get at most two round-robin rounds, not retries or another LLM selector.
    if (!reply.action && turn >= bots.length * 2) return;
    nextBotId = (reply.action === "done" || maxTurns - turn <= unheard.length ? unheard[0]?.id : reply.nextBotId)
      ?? active[(active.indexOf(bot) + 1) % active.length].id;
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
      for (const [index, bot] of targets.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id, userMessage.id); }
      return NextResponse.json({ room: getRoom(id), routedBotIds: targets.map((bot) => bot.id), relay: true, relayDepth: envelope.depth, relayTurnId: envelope.turnId });
    }
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    const prompt = body.prompt.trim();
    const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
    if (!userMessage) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    // Explicit user requests can initiate a bounded conversation without enabling autonomous relay.
    const conversation = isRoomConversationRequest(prompt);
    let routed = botsForRoomPrompt(room, prompt, body.broadcast === true);
    if (conversation && routed.bots.length === 0 && !prompt.includes("@")) routed = botsForRoomPrompt(room, prompt, true);
    if (conversation && routed.bots.length > 1) {
      const participants = [...routed.bots].sort((a, b) => room.members.indexOf(a.id) - room.members.indexOf(b.id));
      void runRoomConversation(room, participants, prompt, userMessage.id).catch((error) => {
        console.error("Room conversation failed", error instanceof Error ? error.message : "Unknown error");
      });
      return NextResponse.json({ room: getRoom(id), routedBotIds: routed.bots.map((bot) => bot.id), broadcast: routed.broadcast });
    }
    const responses = routed.bots.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" })).filter((item): item is NonNullable<typeof item> => Boolean(item));
    for (const [index, bot] of routed.bots.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id, userMessage.id); }
    return NextResponse.json({ room: getRoom(id), routedBotIds: routed.bots.map((bot) => bot.id), broadcast: routed.broadcast });
  } catch (error) { const { error: message, status } = jsonError(error); return NextResponse.json({ error: message }, { status }); }
}
