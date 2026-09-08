import { appendRoomMessage, ensureRoomBotTask, getRoom, roomBotTaskId, roomRequestImages, setRoomOutcome, updateRoomMessage } from "./rooms";
import { getBot } from "./bots";
import { getTask } from "./store";
import { getTaskDetail, promptTask, subscribeTask, abortTask } from "./pi/harness";
import { withBotCodeSessionLock } from "./bot-code-session-lock";
import { pendingRoomCodeRequestForTurn, type CodeRequest } from "./pi/bot-code-relay";
import { toolLabel } from "./tool-labels";
import { latestRoomRequest, MAX_ROOM_CONVERSATION_TURNS, parseRoomReply, roomBotPrompt, type RoomReply, type RoomTurn } from "./room-conversation";
import type { BotDto, RoomDto, RoomOutcome, UiMessage } from "./types";

// Share queue ownership across Next route module instances in the same worker.
const globalRef = globalThis as typeof globalThis & { __leafcodeRoomBotRuns?: Map<string, Promise<void>> };
const roomBotRuns = globalRef.__leafcodeRoomBotRuns ??= new Map<string, Promise<void>>();
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }

const STREAM_INTERVAL_MS = 400;
const CODE_TRACK_TIMEOUT_MS = 60 * 60_000;
const trackedCodeRequests = new Set<string>();

function activeToolLabel(message: UiMessage | null | undefined): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === "tool" && (part.state.status === "pending" || part.state.status === "running")) return toolLabel(part.tool, part.state.input);
  }
  return undefined;
}

/**
 * Mirror what the delegated Code run is doing into the waiting Room message.
 * Only the tool label travels: Code output stays untrusted data behind the report path.
 */
function trackRoomCodeProgress(roomId: string, request: CodeRequest): void {
  const taskId = request.codeTaskId;
  const messageId = request.room?.responseId;
  const requestId = request.room?.conversation.requestId;
  const key = `${roomId}:${request.id}`;
  if (!taskId || !messageId || !requestId || trackedCodeRequests.has(key)) return;
  trackedCodeRequests.add(key);
  let lastLabel = "";
  let lastWriteAt = 0;
  let stop: () => void = () => undefined;
  const settle = () => {
    if (!trackedCodeRequests.delete(key)) return;
    stop();
    clearTimeout(timer);
    updateRoomMessage(roomId, messageId, { codeActivity: "" });
  };
  const timer = setTimeout(settle, CODE_TRACK_TIMEOUT_MS);
  timer.unref?.();
  stop = subscribeTask(taskId, (payload) => {
    if (!pendingRoomCodeRequestForTurn(roomId, requestId)) return settle();
    const message = payload.type === "delta"
      ? payload.message as UiMessage | null
      : (payload.messages as UiMessage[] | undefined)?.at(-1) ?? null;
    const label = activeToolLabel(message)?.slice(0, 80) ?? "";
    const now = Date.now();
    if (label === lastLabel || now - lastWriteAt < STREAM_INTERVAL_MS) return;
    lastLabel = label;
    lastWriteAt = now;
    updateRoomMessage(roomId, messageId, { codeActivity: label });
  });
}

/** Mirror the streaming reply into the room so a turn is readable while it is still being written. */
function streamRoomReply(taskId: string, roomId: string, responseId: string, before: ReadonlySet<string>): () => void {
  let lastText = "";
  let lastWriteAt = 0;
  return subscribeTask(taskId, (payload) => {
    const message = payload.type === "delta"
      ? payload.message as UiMessage | null
      : (payload.messages as UiMessage[] | undefined)?.at(-1) ?? null;
    if (!message || message.role !== "assistant" || before.has(message.id)) return;
    // A directive — even half-typed on the streaming edge — is plumbing, never something to show.
    const lines = textOf(message).split(/\r?\n/);
    const text = lines.filter((line, index) => {
      const bare = line.replace(/^[\s*_`]+/, "").toUpperCase();
      if (!bare) return true;
      return !bare.startsWith("ROOM_ACTION") && !(index === lines.length - 1 && "ROOM_ACTION".startsWith(bare));
    }).join("\n").trimEnd();
    const now = Date.now();
    if (!text || text === lastText || now - lastWriteAt < STREAM_INTERVAL_MS) return;
    lastText = text;
    lastWriteAt = now;
    updateRoomMessage(roomId, responseId, { text, status: "working" });
  });
}

export async function runRoomBot(room: RoomDto, bot: BotDto, prompt: string, responseId: string, requestId: string, turn?: RoomTurn): Promise<RoomReply | undefined> {
  const taskId = roomBotTaskId(room.id, bot.id);
  const previous = roomBotRuns.get(taskId);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  roomBotRuns.set(taskId, current);
  try {
    await previous;
    // Room files are shared across workers, so the in-process queue alone cannot keep two
    // workers from prompting the same room session at once.
    return await withBotCodeSessionLock(`room-turn-${room.id}-${bot.id}`, async () => {
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
    const stopStreaming = streamRoomReply(taskId, room.id, responseId, before);
    // Attachments belong to the request: send them once, on this bot's first turn for it.
    const images = (turn?.turn ?? 1) === 1 ? roomRequestImages(room.id, requestId) : [];
    // Wait for the exact queue entry, not an idle-looking acceptance snapshot.
    try { await promptTask(taskId, context, images.length > 0 ? images : undefined, { waitForCompletion: true }); } finally { stopStreaming(); }
    const detail = await getTaskDetail(taskId);
    const assistant = [...detail.messages].reverse().find((message) => message.role === "assistant" && !before.has(message.id));
    const error = detail.error || assistant?.error;
    const raw = assistant ? textOf(assistant) : "";
    const reply = turn ? parseRoomReply(raw, bot.id, participants) : { text: raw };
    const { text } = reply;
    updateRoomMessage(room.id, responseId, { text: error || (text.trim() ? text : "Bot did not return a response."), status: error || !text.trim() ? "error" : "done" });
    // The turn may have handed work to Code; show what that run is doing while the Room waits.
    const delegated = pendingRoomCodeRequestForTurn(room.id, requestId);
    if (delegated) trackRoomCodeProgress(room.id, delegated);
    return error || !text.trim() ? undefined : reply;
    }, { timeoutMs: ROOM_TURN_LOCK_TIMEOUT_MS });
  } catch (error) {
    updateRoomMessage(room.id, responseId, { text: error instanceof Error ? error.message : String(error), status: "error" });
  } finally {
    release();
    if (roomBotRuns.get(taskId) === current) roomBotRuns.delete(taskId);
  }
}

const STALE_TURN_MS = 5 * 60_000;
const ROOM_TURN_LOCK_TIMEOUT_MS = 10 * 60_000;

/** Turns currently being written in this room, newest first. */
function workingTurns(roomId: string): { messageId: string; botId: string; taskId: string }[] {
  return (getRoom(roomId)?.messages ?? [])
    .filter((message) => message.status === "working" && message.botId)
    .map((message) => ({ messageId: message.id, botId: message.botId!, taskId: roomBotTaskId(roomId, message.botId!) }));
}

/** "Stop now" ends the turns being written. Delegated Code keeps running; it has its own control. */
export async function stopRoomTurns(roomId: string): Promise<number> {
  const turns = workingTurns(roomId);
  const results = await Promise.allSettled(turns.map((entry) => abortTask(entry.taskId)));
  return results.filter((result) => result.status === "fulfilled").length;
}

/**
 * A new instruction redirects the turn already being written instead of queuing behind it.
 * The steered bots answer once, so the caller must not start a second turn for them.
 */
export async function steerRoomTurns(roomId: string, prompt: string): Promise<string[]> {
  const turns = workingTurns(roomId);
  const content = `[割り込み] ユーザーの新しい指示: ${JSON.stringify(prompt)}\nこのターンはこの指示を優先して続ける。`;
  const results = await Promise.allSettled(turns.map((entry) => promptTask(entry.taskId, content, undefined, { streamingBehavior: "steer" })));
  return turns.flatMap((entry, index) => results[index].status === "fulfilled" ? [entry.botId] : []);
}

const FAN_OUT_LIMIT = 4;
/** Independent replies still cost a model call each: keep a large room from starting them all at once. */
export async function runRoomFanOut(room: RoomDto, bots: BotDto[], prompt: string, responseIds: string[], requestId: string): Promise<void> {
  const queue = bots.map((bot, index) => ({ bot, responseId: responseIds[index] })).filter((entry) => entry.responseId);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < queue.length; index = next++) {
      const entry = queue[index];
      await runRoomBot(room, entry.bot, prompt, entry.responseId, requestId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAN_OUT_LIMIT, queue.length) }, worker));
}

/** A crashed worker leaves "working" placeholders behind; nothing else ever settles them. */
export function settleStaleRoomTurns(roomId: string, now = Date.now()): number {
  const stale = (getRoom(roomId)?.messages ?? []).filter((message) => {
    if (message.status !== "working" || now - message.createdAt <= STALE_TURN_MS) return false;
    if (!message.botId) return true;
    // A slow turn is not an abandoned one: never settle a run this worker owns, nor one whose
    // task record is still being updated by another worker.
    const taskId = roomBotTaskId(roomId, message.botId);
    if (roomBotRuns.has(taskId)) return false;
    const task = getTask(taskId);
    const touchedAt = task ? Date.parse(task.updatedAt) : Number.NaN;
    return !(task?.status === "working" && Number.isFinite(touchedAt) && now - touchedAt <= STALE_TURN_MS);
  });
  for (const message of stale) updateRoomMessage(roomId, message.id, { text: "応答が中断されました。", status: "error" });
  return stale.length;
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
  // Rotate the opener so the first member does not lead every exchange.
  const lastSpeaker = room.messages.findLast((message) => message.role === "assistant" && message.botId)?.botId;
  let nextBotId = resume?.nextBotId ?? bots.find((bot) => bot.id !== lastSpeaker)?.id ?? bots[0]?.id;
  // A silent return reads as "finished"; record why the floor stopped moving instead.
  const stop = (kind: RoomOutcome["kind"]) => setRoomOutcome(room.id, { kind, requestId: userMessageId });
  for (let turn = resume?.startTurn ?? 1; turn <= maxTurns; turn += 1) {
    const current = getRoom(room.id);
    if (!current || latestRoomRequest(current)?.id !== userMessageId) return;
    const active = bots.filter((bot) => current.members.includes(bot.id) && getBot(bot.id)?.enabled);
    if (active.length < 2) return stop("members");
    const bot = active.find((member) => member.id === nextBotId) ?? active.find((member) => !spoken.has(member.id)) ?? active[0];
    const response = appendRoomMessage(room.id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working" });
    if (!response) return;
    const reply = await runRoomBot(room, bot, prompt, response.id, userMessageId, { participants: active, turn, maxTurns });
    // A tool receipt is not a result. The durable Code outbox resumes only after the real report is delivered.
    if (pendingRoomCodeRequestForTurn(room.id, userMessageId)) return stop("code-wait");
    if (!reply) return;
    spoken.add(bot.id);
    const normalized = reply.text.trim().replace(/\s+/g, " ");
    const previous = replies.get(bot.id) ?? new Set<string>();
    if (previous.has(normalized)) return stop("repeat");
    previous.add(normalized);
    replies.set(bot.id, previous);
    // The speaker ends the exchange; nobody is dragged in just because they have not spoken yet.
    if (reply.action === "done") return stop("done");
    // ponytail: a model ignoring the protocol gets one round-robin pass, not retries or an LLM selector.
    if (!reply.action && turn >= bots.length) return stop("done");
    nextBotId = reply.nextBotId ?? active[(active.indexOf(bot) + 1) % active.length].id;
  }
  stop("turns");
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
