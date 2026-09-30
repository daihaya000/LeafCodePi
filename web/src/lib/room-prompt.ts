import { getBot } from "@/lib/bots";
import { jsonError } from "@/lib/pi/harness";
import { cancelRoomCodeRequests } from "@/lib/pi/bot-code-relay";
import { isPromptFileList, isPromptImageList, isPromptTextWithinSize, MAX_PROMPT_ATTACHMENTS, type PromptFileInput } from "@/lib/prompt-images";
import { isRoomConversationRequest, isRoomStopRequest, MAX_ROOM_CONVERSATION_PARTICIPANTS, latestRoomRequest } from "@/lib/room-conversation";
import { resolveRoomOpener, type RoomOpenerReason } from "@/lib/room-opener";
import { cancelPendingRoomHandoffs, deliverReadyRoomHandoffs, runRoomBot, runRoomConversation, runRoomFanOut, settleRoomHandoffs, settleStaleRoomTurns, steerRoomTurns, stopRoomTurns } from "@/lib/room-runtime";
import { appendRoomMessage, botsForRoomPrompt, consumeRoomRelayEnvelope, getRoom, roomFileRejection, roomImageRejection, saveRoomFiles, saveRoomImages, updateRoomMessage } from "@/lib/rooms";
import type { BotDto, RoomMessage } from "@/lib/types";

export type RoomPromptBody = {
  prompt?: unknown; broadcast?: unknown; fromBot?: unknown; relayEnvelope?: unknown; images?: unknown; files?: unknown;
};

/** The HTTP answer one Room prompt produces; the caller sends this status and body as-is. */
export type RoomPromptResult = { status: number; body: unknown };

/**
 * One Room prompt, from validation to routing.
 *
 * The whole ladder lives here because the owning WebUI route and the Backend owner both serve it:
 * appending turns, consuming the relay envelope, steering and starting sessions are owner work, so
 * after the cutover the WebUI forwards the same body and replays the owner's answer unchanged.
 */
export async function handleRoomPrompt(roomId: string, body: RoomPromptBody | null): Promise<RoomPromptResult> {
  try {
    const id = roomId;
    const room = getRoom(id);
    if (!room) return { status: 404, body: { error: "Room not found" } };
    if (typeof body?.prompt === "string" && !isPromptTextWithinSize(body.prompt)) {
      return { status: 413, body: { error: "本文プロンプトが長すぎます" } };
    }
    const isRelayRequest = body?.fromBot === true || body?.relayEnvelope !== undefined;
    if (isRelayRequest) {
      if (typeof body?.prompt !== "string" || !body.prompt.trim()) return { status: 400, body: { error: "Prompt is required" } };
      // Only a server-issued, single-use envelope can establish source, targets, depth, and turn.
      // Client fromBot / turnId / sourceBotId / depth are never trusted.
      const envelope = typeof body.relayEnvelope === "string" ? consumeRoomRelayEnvelope(id, body.relayEnvelope) : undefined;
      if (!envelope) return { status: 403, body: { error: "A valid server relay envelope is required" } };
      const prompt = body.prompt.trim();
      const userMessage = appendRoomMessage(id, { role: "user", text: prompt, sourceBotId: envelope.sourceBotId, relayTurnId: envelope.turnId, relayDepth: envelope.depth });
      if (!userMessage) return { status: 404, body: { error: "Room not found" } };
      const targets = envelope.targetBotIds.map((botId) => getBot(botId)).filter((bot): bot is BotDto => Boolean(bot));
      const responses = targets.map((bot) => appendRoomMessage(id, { role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working", sourceBotId: envelope.sourceBotId, relayTurnId: envelope.turnId, relayDepth: envelope.depth, relayParentMessageId: userMessage.id })).filter((item): item is RoomMessage => Boolean(item));
      for (const [index, bot] of targets.entries()) { const response = responses[index]; if (response) void runRoomBot(room, bot, prompt, response.id, userMessage.id); }
      return { status: 200, body: { room: getRoom(id), routedBotIds: targets.map((bot) => bot.id), relay: true, relayDepth: envelope.depth, relayTurnId: envelope.turnId } };
    }
    if (typeof body?.prompt !== "string") return { status: 400, body: { error: "Prompt is required" } };
    // Attachments only ever come from the user composer, never from a relayed bot payload.
    if (body.images !== undefined && !isPromptImageList(body.images)) return { status: 400, body: { error: "invalid images" } };
    if (body.files !== undefined && !isPromptFileList(body.files)) return { status: 400, body: { error: "invalid files" } };
    const images = body.images ?? [];
    const files = body.files ?? [];
    if (images.length + files.length > MAX_PROMPT_ATTACHMENTS) return { status: 400, body: { error: `添付は${MAX_PROMPT_ATTACHMENTS}件までです` } };
    const imageRejection = images.length > 0 ? roomImageRejection(images) : undefined;
    if (imageRejection) return { status: 400, body: { error: imageRejection } };
    const fileRejection = files.length > 0 ? roomFileRejection(files as PromptFileInput[]) : undefined;
    if (fileRejection) return { status: 400, body: { error: fileRejection } };
    if (!body.prompt.trim() && images.length === 0 && files.length === 0) return { status: 400, body: { error: "Prompt is required" } };
    const prompt = body.prompt.trim();
    settleStaleRoomTurns(id);
    if (isRoomStopRequest(prompt)) {
      const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
      if (!userMessage) return { status: 404, body: { error: "Room not found" } };
      const stopped = await stopRoomTurns(id);
      const cancelledHandoffs = cancelPendingRoomHandoffs(id);
      return { status: 200, body: { room: getRoom(id), routedBotIds: [], stopped: true, stoppedTurns: stopped, cancelledHandoffs } };
    }
    // Recovery scan before the new request lands: resolve handoffs whose trigger was missed
    // (restart, crash) and let ready ones claim the floor first; a new user message can steer them.
    if (settleRoomHandoffs(id) > 0) void deliverReadyRoomHandoffs(id).catch(() => console.error("Room handoff delivery failed"));
    const supersededRequestId = latestRoomRequest(getRoom(id) ?? room)?.id;
    const userMessage = appendRoomMessage(id, { role: "user", text: prompt });
    if (!userMessage) return { status: 404, body: { error: "Room not found" } };
    // A newer user turn supersedes prior Code outbox jobs (same finality as revert).
    if (supersededRequestId) {
      void cancelRoomCodeRequests(id, supersededRequestId).catch((error) =>
        console.warn("[room-prompt] superseded Code cancel failed:", error instanceof Error ? error.message : String(error)),
      );
    }
    // ponytail: attachment files outlive a revert; the whole directory goes when the room is deleted.
    if (images.length > 0) {
      const saved = saveRoomImages(id, userMessage.id, images);
      if (saved.length > 0) updateRoomMessage(id, userMessage.id, { images: saved });
    }
    if (files.length > 0) {
      const saved = saveRoomFiles(id, userMessage.id, files as PromptFileInput[]);
      if (saved.length > 0) updateRoomMessage(id, userMessage.id, { files: saved });
    }
    // A new instruction redirects the turns already being written; those bots answer once, there.
    const steered = new Set(await steerRoomTurns(id, prompt, userMessage.id));
    // Everyday @-less work is single-bot (keyword first, else LLM). Open rotate is reserved for /discuss-like only.
    const conversation = isRoomConversationRequest(prompt);
    let routed = botsForRoomPrompt(room, prompt, body.broadcast === true);
    let singleOpenerReason: RoomOpenerReason | undefined;
    if (routed.bots.length === 0 && !prompt.includes("@") && body.broadcast !== true) {
      if (conversation) {
        routed = botsForRoomPrompt(room, prompt, true);
      } else {
        const members = [...botsForRoomPrompt(room, prompt, true).bots].sort((a, b) => room.members.indexOf(a.id) - room.members.indexOf(b.id));
        const opener = await resolveRoomOpener({ prompt, bots: members });
        if (opener) {
          routed = { bots: [opener.bot], broadcast: false };
          singleOpenerReason = opener.reason;
        }
      }
    }
    const pending = routed.bots.filter((bot) => !steered.has(bot.id));
    if (conversation && pending.length > 1) {
      const participants = [...pending].sort((a, b) => room.members.indexOf(a.id) - room.members.indexOf(b.id)).slice(0, MAX_ROOM_CONVERSATION_PARTICIPANTS);
      void runRoomConversation(room, participants, prompt, userMessage.id).catch(() => console.error("Room conversation failed"));
      return { status: 200, body: { room: getRoom(id), routedBotIds: participants.map((bot) => bot.id), steeredBotIds: [...steered], broadcast: routed.broadcast } };
    }
    const responses = pending.map((bot, index) => appendRoomMessage(id, {
      role: "assistant", botId: bot.id, botName: bot.name, text: "", status: "working",
      ...(index === 0 && singleOpenerReason ? { openerReason: singleOpenerReason } : {}),
    })).filter((item): item is NonNullable<typeof item> => Boolean(item));
    void runRoomFanOut(room, pending, prompt, responses.map((response) => response.id), userMessage.id).catch(() => console.error("Room fan-out failed"));
    return { status: 200, body: { room: getRoom(id), routedBotIds: pending.map((bot) => bot.id), steeredBotIds: [...steered], broadcast: routed.broadcast } };
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return { status, body: { error: message } };
  }
}
