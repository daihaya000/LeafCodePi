import { appendRoomMessage, ensureRoomBotTask, getRoom, roomBotTaskId, updateRoomMessage } from "./rooms";
import { getBot } from "./bots";
import { getTaskDetail, promptTask } from "./pi/harness";
import { pendingRoomCodeRequest, type CodeRequest } from "./pi/bot-code-relay";
import { latestRoomRequest, MAX_ROOM_CONVERSATION_TURNS, parseRoomReply, roomBotPrompt, type RoomReply, type RoomTurn } from "./room-conversation";
import type { BotDto, RoomDto, UiMessage } from "./types";

// Share queue ownership across Next route module instances in the same worker.
const globalRef = globalThis as typeof globalThis & { __leafcodeRoomBotRuns?: Map<string, Promise<void>> };
const roomBotRuns = globalRef.__leafcodeRoomBotRuns ??= new Map<string, Promise<void>>();
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }

export async function runRoomBot(room: RoomDto, bot: BotDto, prompt: string, responseId: string, requestId: string, turn?: RoomTurn): Promise<RoomReply | undefined> {
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
    updateRoomMessage(room.id, responseId, { conversation: { requestId, participantIds: turn ? participants.map((member) => member.id) : [bot.id], turn: turn?.turn ?? 1, maxTurns: turn?.maxTurns ?? 1 } });
    const context = roomBotPrompt(currentRoom, bot, participants, prompt, requestId, turn);
    // Wait for the exact queue entry, not an idle-looking acceptance snapshot.
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

type Resume = { startTurn: number; maxTurns: number; nextBotId: string };
export async function runRoomConversation(room: RoomDto, bots: BotDto[], prompt: string, userMessageId: string, resume?: Resume) {
  const maxTurns = Math.min(MAX_ROOM_CONVERSATION_TURNS, resume?.maxTurns ?? bots.length * 2);
  const prior = room.messages.filter((message) => message.conversation?.requestId === userMessageId && message.status === "done");
  const spoken = new Set(prior.flatMap((message) => message.botId ? [message.botId] : []));
  const replies = new Map<string, Set<string>>();
  for (const message of prior) if (message.botId) {
    const texts = replies.get(message.botId) ?? new Set<string>();
    texts.add(message.text.trim().replace(/\s+/g, " "));
    replies.set(message.botId, texts);
  }
  let nextBotId = resume?.nextBotId ?? bots[0]?.id;
  for (let turn = resume?.startTurn ?? 1; turn <= maxTurns; turn += 1) {
    const current = getRoom(room.id);
    if (!current || latestRoomRequest(current)?.id !== userMessageId) return;
    const active = bots.filter((bot) => current.members.includes(bot.id) && getBot(bot.id)?.enabled);
    if (active.length < 2) return;
    const bot = active.find((member) => member.id === nextBotId) ?? active.find((member) => !spoken.has(member.id)) ?? active[0];
    const response = appendRoomMessage(room.id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" });
    if (!response) return;
    const reply = await runRoomBot(room, bot, prompt, response.id, userMessageId, { participants: active, turn, maxTurns });
    // A tool receipt is not a result. The durable Code outbox resumes only after the real report is delivered.
    if (!reply || pendingRoomCodeRequest(room.id)) return;
    spoken.add(bot.id);
    const normalized = reply.text.trim().replace(/\s+/g, " ");
    const previous = replies.get(bot.id) ?? new Set<string>();
    if (previous.has(normalized)) return;
    previous.add(normalized);
    replies.set(bot.id, previous);
    // The speaker ends the exchange; nobody is dragged in just because they have not spoken yet.
    if (reply.action === "done") return;
    // ponytail: a model ignoring the protocol gets one round-robin pass, not retries or an LLM selector.
    if (!reply.action && turn >= bots.length) return;
    nextBotId = reply.nextBotId ?? active[(active.indexOf(bot) + 1) % active.length].id;
  }
}

/** Called only after a correlated Bot report exists, including retries after a process restart. */
export function deliverRoomCodeReport(request: CodeRequest, text: string): boolean {
  if (!request.room) return false;
  const room = getRoom(request.room.id);
  const bot = getBot(request.botId);
  if (!room || !bot?.enabled || !room.members.includes(bot.id)) return false;
  const participants = request.room.conversation.participantIds.map(getBot).filter((member): member is BotDto => Boolean(member?.enabled && room.members.includes(member.id)));
  const reply = parseRoomReply(text, bot.id, participants);
  if (!reply.text.trim()) return false;
  request.room.nextBotId = reply.nextBotId;
  request.room.complete = reply.action === "done";
  return Boolean(appendRoomMessage(room.id, {
    id: `code-report:${request.id}`, role: "assistant", botId: bot.id, botName: bot.name,
    text: reply.text, status: "done", codeRequestId: request.id, codeTaskId: request.codeTaskId, codeState: "delivered",
    conversation: request.room.conversation,
  }));
}

/** At-most-once automatic continuation: the outbox marks delivered before invoking this callback. */
export async function resumeRoomAfterCode(request: CodeRequest): Promise<void> {
  if (!request.room || request.room.complete) return;
  const room = getRoom(request.room.id);
  const { requestId, participantIds, turn, maxTurns } = request.room.conversation;
  if (!room || latestRoomRequest(room)?.id !== requestId || turn >= maxTurns) return;
  // Failures, interrupted jobs, or unknown outcomes require fresh human direction, not another mutation.
  try { if (JSON.parse(request.result ?? "{}").outcome !== "実行終了") return; } catch { return; }
  const participants = participantIds.map(getBot).filter((bot): bot is BotDto => Boolean(bot?.enabled && room.members.includes(bot.id)));
  if (participants.length < 2) return;
  const target = participants.find((bot) => bot.id === request.room?.nextBotId && bot.id !== request.botId)
    ?? participants[(participants.findIndex((bot) => bot.id === request.botId) + 1) % participants.length];
  await runRoomConversation(room, participants, latestRoomRequest(room)!.text, requestId, { startTurn: turn + 1, maxTurns, nextBotId: target.id });
}
