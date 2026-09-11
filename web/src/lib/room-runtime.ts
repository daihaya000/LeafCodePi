import { randomUUID } from "node:crypto";
import { appendRoomMessage, appendRoomMessageIf, ensureRoomBotTask, getRoom, listRooms, roomBotTaskId, roomRequestImages, setRoomOutcome, updateRoomHandoffs, updateRoomMessage } from "./rooms";
import { getBot } from "./bots";
import { getTask } from "./store";
import { getTaskDetail, promptTask, subscribeTask, abortTask } from "./pi/harness";
import { withBotCodeSessionLock } from "./bot-code-session-lock";
import { pendingRoomCodeRequestForTurn, pendingRoomCodeRequestsForTurn, roomCodeRequestsForTurn, roomCodeRequestForRoom, settledRoomCodeRequest, type CodeRequest } from "./pi/bot-code-relay";
import { activeToolLabel } from "./tool-labels";
import { latestRoomRequest, MAX_ROOM_CONVERSATION_TURNS, parseRoomReply, roomBotPrompt, type RoomReply, type RoomTurn } from "./room-conversation";
import type { BotDto, RoomDto, RoomHandoff, RoomMessage, RoomOutcome, UiMessage } from "./types";

// Share queue ownership across Next route module instances in the same worker.
const globalRef = globalThis as typeof globalThis & { __leafcodeRoomBotRuns?: Map<string, Promise<void>> };
const roomBotRuns = globalRef.__leafcodeRoomBotRuns ??= new Map<string, Promise<void>>();
function textOf(message: UiMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""); }

const STREAM_INTERVAL_MS = 400;
const CODE_TRACK_TIMEOUT_MS = 60 * 60_000;
const trackedCodeRequests = new Set<string>();

/**
 * Mirror what the delegated Code run is doing into the waiting Room message.
 * Per-request cards poll their own Code task, so this message-level label only feeds the legacy
 * shape (codeState without codeRequests); only the tool label travels, Code output stays untrusted.
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
    // Parallel requests share one message, so every outstanding job mirrors its activity.
    for (const delegated of pendingRoomCodeRequestsForTurn(room.id, requestId)) trackRoomCodeProgress(room.id, delegated);
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
      // A ready handoff registered during this reply takes the floor once; concurrent workers are safe.
      if ((getRoom(room.id)?.handoffs ?? []).some((handoff) => handoff.requestId === requestId && handoff.state === "ready")) {
        await deliverReadyRoomHandoffs(room.id);
        return;
      }
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

/** Recover room placeholders and ready handoffs after a worker restart. */
export function reconcileRoomRuntime(): void {
  for (const room of listRooms()) {
    settleStaleRoomTurns(room.id);
    if (settleRoomHandoffs(room.id) > 0) {
      void deliverReadyRoomHandoffs(room.id).catch((error) => {
        console.warn("[room-runtime] startup handoff recovery failed:", error instanceof Error ? error.message : String(error));
      });
    }
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
    // A registered handoff owns the floor: deliver it now instead of continuing the round-robin.
    if ((getRoom(room.id)?.handoffs ?? []).some((handoff) => handoff.requestId === userMessageId && handoff.state === "ready")) {
      stop("done");
      await deliverReadyRoomHandoffs(room.id);
      return;
    }
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
  const report = appendRoomMessageIf(room.id, (current) => current.messages.some(
    (message) => message.role === "user" && message.id === request.room?.conversation.requestId,
  ), {
    id: `code-report:${request.id}`, role: "assistant", botId: bot.id, botName: bot.name,
    text: reply.text, status: "done", codeRequestId: request.id, codeTaskId: request.codeTaskId, codeState: "delivered",
    conversation: request.room.conversation,
  });
  // A Room conversation can have queued Code jobs. Keep it waiting until this
  // report is the last outstanding job for that conversation.
  const currentRoom = getRoom(room.id);
  if (report && !pendingRoomCodeRequestForTurn(room.id, request.room.conversation.requestId, request.id)
    && currentRoom?.lastOutcome?.kind === "code-wait" && currentRoom.lastOutcome.requestId === request.room.conversation.requestId) {
    setRoomOutcome(room.id, { kind: "done", requestId: request.room.conversation.requestId });
  }
  return Boolean(report);
}

/** At-most-once automatic continuation: the outbox marks delivered before invoking this callback. */
export async function resumeRoomAfterCode(request: CodeRequest): Promise<void> {
  if (!request.room) return;
  // Handoffs registered before the report are settled first: a speaker's DONE must not drop them.
  const activated = settleRoomHandoffsForCode(request);
  if (activated.length > 0) { await deliverReadyRoomHandoffs(request.room.id); return; }
  if (request.room.complete) return;
  const room = getRoom(request.room.id);
  const { requestId, participantIds, turn, maxTurns } = request.room.conversation;
  if (!room || latestRoomRequest(room)?.id !== requestId || turn >= maxTurns) return;
  // Do not resume the conversation after only one of several queued Code jobs
  // reports; the remaining jobs still own the turn.
  if (pendingRoomCodeRequestForTurn(room.id, requestId, request.id)) return;
  // Failures, interrupted jobs, or unknown outcomes require fresh human direction, not another mutation.
  if (!codeResultSucceeded(request)) return;
  // Parallel Code requests share one Room turn. A successful last report must not hide a sibling
  // that failed or was stopped; require every persisted request for this turn to have succeeded.
  if (roomCodeRequestsForTurn(room.id, requestId).some((item) => item.id !== request.id && !codeResultSucceeded(item))) return;
  const participants = participantIds.map(getBot).filter((bot): bot is BotDto => Boolean(bot?.enabled && room.members.includes(bot.id)));
  if (participants.length < 2) return;
  const target = participants.find((bot) => bot.id === request.room?.nextBotId && bot.id !== request.botId)
    ?? participants[(participants.findIndex((bot) => bot.id === request.botId) + 1) % participants.length];
  await runRoomConversation(room, participants, latestRoomRequest(room)!.text, requestId, { startTurn: turn + 1, maxTurns, nextBotId: target.id });
}

const HANDOFF_TASK_MAX = 2_000;
/** Settled records only guard tool-call replay, so bound the room file instead of archiving them. */
const MAX_ROOM_HANDOFFS = 50;

function handoffCodeOutcome(request: Pick<CodeRequest, "result">): string | undefined {
  try { return JSON.parse(request.result ?? "{}").outcome; } catch { return undefined; }
}
function codeResultSucceeded(request: Pick<CodeRequest, "result">): boolean {
  const outcome = handoffCodeOutcome(request);
  return outcome === "実行終了" || outcome === "目標達成";
}

/** Mirror the handoff records of a message back onto it, so the transcript shows what was registered. */
function mirrorHandoffs(roomId: string): void {
  const room = getRoom(roomId);
  if (!room?.handoffs?.length) return;
  const byMessage = new Map<string, NonNullable<RoomMessage["handoffs"]>>();
  for (const handoff of room.handoffs) {
    const list = byMessage.get(handoff.fromMessageId) ?? [];
    list.push({ id: handoff.id, toBotId: handoff.toBotId, toBotName: getBot(handoff.toBotId)?.name ?? "不明なBot", state: handoff.state });
    byMessage.set(handoff.fromMessageId, list);
  }
  for (const [messageId, handoffs] of byMessage) updateRoomMessage(roomId, messageId, { handoffs });
}

function patchHandoff(roomId: string, handoffId: string, patch: (handoff: RoomHandoff) => RoomHandoff | undefined): void {
  updateRoomHandoffs(roomId, (handoffs) => handoffs.flatMap((handoff) => {
    if (handoff.id !== handoffId) return [handoff];
    const next = patch(handoff);
    return next ? [next] : [];
  }));
  mirrorHandoffs(roomId);
}

/**
 * Register follow-up work for another participant. Called only from the room_handoff tool:
 * the room, conversation, and speaker are server-resolved, never taken from model arguments.
 */
export function registerRoomHandoff(input: {
  roomId: string; requestId: string; fromMessageId: string; fromBotId: string;
  toBotId: string; task: string; waitForCodeRequestId?: string; toolCallId?: string;
}): { handoff: RoomHandoff; duplicate: boolean } {
  const room = getRoom(input.roomId);
  if (!room || latestRoomRequest(room)?.id !== input.requestId) throw new Error("Room request is no longer active");
  const from = room.messages.find((message) => message.id === input.fromMessageId);
  if (!from || from.botId !== input.fromBotId || !(from.status === "working" || from.conversation?.requestId === input.requestId)) {
    throw new Error("This turn can no longer register handoffs");
  }
  const lowered = input.toBotId.trim().toLowerCase();
  const target = room.members.map(getBot).find((bot) => bot?.enabled && (bot.id.toLowerCase() === lowered || bot.name.toLowerCase() === lowered));
  if (!target || target.id === input.fromBotId) throw new Error("Handoffs must name another enabled participant of this room");
  const task = input.task.trim();
  if (!task || task.length > HANDOFF_TASK_MAX) throw new Error(`A handoff task of 1–${HANDOFF_TASK_MAX} characters is required`);
  if (input.waitForCodeRequestId && roomCodeRequestForRoom(input.roomId, input.waitForCodeRequestId)?.room?.conversation.requestId !== input.requestId) {
    throw new Error("Unknown or already settled code request id; omit waitForCodeRequestId to register the handoff without waiting");
  }
  const existing = room.handoffs ?? [];
  // Replays of the same tool call return the original receipt instead of a second registration.
  const replayed = input.toolCallId ? existing.find((handoff) => handoff.toolCallId === input.toolCallId) : undefined;
  if (replayed) return { handoff: replayed, duplicate: true };
  const normalized = task.replace(/\s+/g, " ");
  const equivalent = existing.find((handoff) => handoff.requestId === input.requestId && handoff.toBotId === target.id
    && handoff.waitForCodeRequestId === input.waitForCodeRequestId && handoff.task.replace(/\s+/g, " ") === normalized
    && (handoff.state === "waiting" || handoff.state === "ready" || handoff.state === "running"));
  if (equivalent) return { handoff: equivalent, duplicate: true };
  const now = Date.now();
  const handoff: RoomHandoff = {
    id: randomUUID(), requestId: input.requestId, fromMessageId: input.fromMessageId, fromBotId: input.fromBotId,
    toBotId: target.id, task, ...(input.waitForCodeRequestId ? { waitForCodeRequestId: input.waitForCodeRequestId } : {}),
    state: input.waitForCodeRequestId ? "waiting" : "ready", ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    createdAt: now, updatedAt: now,
  };
  updateRoomHandoffs(input.roomId, (handoffs) => {
    // Make room for the new record by dropping the oldest settled one.
    const firstSettled = handoffs.find((item) => item.state === "done" || item.state === "failed" || item.state === "cancelled");
    const kept = handoffs.length >= MAX_ROOM_HANDOFFS && firstSettled
      ? handoffs.filter((item) => item.id !== firstSettled.id)
      : handoffs;
    return [...kept, handoff];
  });
  mirrorHandoffs(input.roomId);
  return { handoff, duplicate: false };
}

/** Settle the handoffs waiting on this Code request; returns the ones it activated (ready). */
export function settleRoomHandoffsForCode(request: CodeRequest): RoomHandoff[] {
  if (!request.room) return [];
  const room = getRoom(request.room.id);
  const waiting = (room?.handoffs ?? []).filter((handoff) => handoff.state === "waiting" && handoff.waitForCodeRequestId === request.id);
  if (!room || waiting.length === 0) return [];
  const success = codeResultSucceeded(request);
  updateRoomHandoffs(request.room.id, (handoffs) => handoffs.map((handoff) => {
    if (handoff.state !== "waiting" || handoff.waitForCodeRequestId !== request.id) return handoff;
    return success
      ? { ...handoff, state: "ready" as const, updatedAt: Date.now() }
      : { ...handoff, state: "failed" as const, reason: `Code依頼が成功しなかったため実行しません（${handoffCodeOutcome(request) ?? "結果なし"}）`, updatedAt: Date.now() };
  }));
  mirrorHandoffs(request.room.id);
  return success ? waiting : [];
}

/**
 * Recovery scan on user activity: resolve running/waiting handoffs the current triggers missed
 * (a crashed worker, a delivery before the scan) and report whether delivery should run.
 */
export function settleRoomHandoffs(roomId: string): number {
  const room = getRoom(roomId);
  if (!room?.handoffs?.length) return 0;
  const latestRequestId = latestRoomRequest(room)?.id;
  let dirty = false;
  let deliverable = false;
  for (const handoff of room.handoffs) {
    if (handoff.state === "done" || handoff.state === "failed" || handoff.state === "cancelled") continue;
    if (handoff.requestId !== latestRequestId) {
      patchHandoff(roomId, handoff.id, (current) => ({ ...current, state: "failed", reason: "会話が新しい指示に置き換わったため実行しません", updatedAt: Date.now() }));
      dirty = true;
    } else if (handoff.state === "running") {
      const message = room.messages.find((item) => item.id === handoff.responseMessageId);
      if (!message) {
        patchHandoff(roomId, handoff.id, (current) => ({ ...current, state: "failed", reason: "中断されました（要確認）", updatedAt: Date.now() }));
        dirty = true;
      } else if (message.status !== "working") {
        patchHandoff(roomId, handoff.id, (current) => message.status === "done" ? { ...current, state: "done", updatedAt: Date.now() } : { ...current, state: "failed", reason: "中断されました（要確認）", updatedAt: Date.now() });
        dirty = true;
      } else if (getTask(roomBotTaskId(roomId, handoff.toBotId))?.status === "error") {
        patchHandoff(roomId, handoff.id, (current) => ({ ...current, state: "failed", reason: "実行タスクが停止したため実行を完了できませんでした", updatedAt: Date.now() }));
        dirty = true;
      }
    } else if (handoff.state === "waiting" && handoff.waitForCodeRequestId) {
      const settled = settledRoomCodeRequest(roomId, handoff.waitForCodeRequestId);
      if (settled) {
        const activated = settleRoomHandoffsForCode(settled);
        dirty = true;
        deliverable ||= activated.length > 0;
      } else if (!roomCodeRequestForRoom(roomId, handoff.waitForCodeRequestId)) {
        patchHandoff(roomId, handoff.id, (current) => ({ ...current, state: "failed", reason: "待機先のCode依頼が見つかりません", updatedAt: Date.now() }));
        dirty = true;
      }
    } else if (handoff.state === "ready") {
      deliverable = true;
    }
  }
  if (dirty) mirrorHandoffs(roomId);
  return deliverable ? 1 : 0;
}

/** "Stop now" also cancels handoffs that have not started; a running one ends with its aborted turn. */
export function cancelPendingRoomHandoffs(roomId: string): number {
  const room = getRoom(roomId);
  const pending = (room?.handoffs ?? []).filter((handoff) => handoff.state === "waiting" || handoff.state === "ready");
  if (pending.length === 0) return 0;
  updateRoomHandoffs(roomId, (handoffs) => handoffs.map((handoff) => pending.some((item) => item.id === handoff.id)
    ? { ...handoff, state: "cancelled", reason: "ユーザーが停止しました", updatedAt: Date.now() }
    : handoff));
  mirrorHandoffs(roomId);
  return pending.length;
}

/** Deliver every ready handoff of this room, one at a time; claims under the room lock prevent double runs. */
export async function deliverReadyRoomHandoffs(roomId: string): Promise<void> {
  for (;;) {
    const room = getRoom(roomId);
    const next = room?.handoffs?.find((handoff) => handoff.state === "ready");
    if (!room || !next) return;
    const requestId = next.requestId;
    if (latestRoomRequest(room)?.id !== requestId) {
      patchHandoff(roomId, next.id, (current) => ({ ...current, state: "failed", reason: "会話が新しい指示に置き換わったため実行しません", updatedAt: Date.now() }));
      continue;
    }
    const bot = getBot(next.toBotId);
    if (!bot?.enabled || !room.members.includes(bot.id)) {
      patchHandoff(roomId, next.id, (current) => ({ ...current, state: "failed", reason: "宛先Botが無効なため実行しません", updatedAt: Date.now() }));
      continue;
    }
    // Claim before opening the turn: a concurrent deliverer loses the race here.
    const claimed = updateRoomHandoffs(roomId, (handoffs) => handoffs.map((handoff) => handoff.id === next.id && handoff.state === "ready"
      ? { ...handoff, state: "running", updatedAt: Date.now() }
      : handoff));
    if (!claimed?.some((handoff) => handoff.id === next.id && handoff.state === "running")) continue;
    const participants = room.members.map(getBot).filter((member): member is BotDto => Boolean(member?.enabled));
    const turnIndex = (room.handoffs?.filter((handoff) => handoff.responseMessageId).length ?? 0) + 1;
    const placeholder = appendRoomMessage(roomId, {
      role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working",
      conversation: { requestId, participantIds: participants.map((member) => member.id), turn: turnIndex, maxTurns: MAX_ROOM_CONVERSATION_TURNS },
    });
    if (!placeholder) return;
    patchHandoff(roomId, next.id, (current) => current.state === "running" ? { ...current, responseMessageId: placeholder.id, updatedAt: Date.now() } : current);
    const turn: RoomTurn = {
      participants, turn: turnIndex, maxTurns: MAX_ROOM_CONVERSATION_TURNS,
      handoff: { fromBotName: getBot(next.fromBotId)?.name ?? "他のBot", task: next.task },
    };
    const reply = await runRoomBot(room, bot, latestRoomRequest(room)?.text ?? "", placeholder.id, requestId, turn);
    patchHandoff(roomId, next.id, (current) => current.state !== "running" ? current
      : reply ? { ...current, state: "done", updatedAt: Date.now() }
      : { ...current, state: "failed", reason: "応答を取得できませんでした", updatedAt: Date.now() });
  }
}
