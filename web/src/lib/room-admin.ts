import { assertKnownRoomMembers, deleteRoom, getRoom, isRoomNameWithinSize, patchRoom, roomBotTaskId } from "@/lib/rooms";
import { destroyTask, jsonError, resetTaskConversation } from "@/lib/pi/harness";
import { stopAllRoomCodeSessions } from "@/lib/pi/bot-code-relay";
import { cancelPendingRoomHandoffs, detachBotFromRoomRuntime, stopRoomTurns } from "@/lib/room-runtime";
import { getTask, listTasks } from "@/lib/store";

export type RoomAdminBody = {
  name?: unknown; members?: unknown; botRelayEnabled?: unknown; codeAutoApprove?: unknown; resetMessages?: unknown;
};

/** The HTTP answer one Room admin action produces; the caller sends this status and body as-is. */
export type RoomAdminResult = { status: number; body: unknown };

/** Relay / standing Code approval are privileged mutations: the WebUI token must allow them. */
export function hasPrivilegedRoomMutation(body: RoomAdminBody | null): boolean {
  return body?.botRelayEnabled !== undefined || body?.codeAutoApprove !== undefined;
}

/**
 * One Room settings change (PATCH), including the destructive teardown of `resetMessages` and the
 * session detach of a removed member.
 *
 * The ladder lives here because the owning WebUI route and the Backend owner both serve it: stopping
 * turns, resetting member conversations and detaching a Bot are owner work, so after the cutover the
 * WebUI forwards the same body and replays the owner's answer unchanged. The caller has already
 * checked the WebUI token for a privileged mutation.
 */
export async function handleRoomPatch(roomId: string, body: RoomAdminBody | null): Promise<RoomAdminResult> {
  try {
    const id = roomId;
    if (
      !body ||
      (body.name !== undefined && (typeof body.name !== "string" || !isRoomNameWithinSize(body.name))) ||
      (body.members !== undefined && (!Array.isArray(body.members) || body.members.some((item) => typeof item !== "string"))) ||
      (body.botRelayEnabled !== undefined && typeof body.botRelayEnabled !== "boolean") ||
      (body.codeAutoApprove !== undefined && typeof body.codeAutoApprove !== "boolean") ||
      (body.resetMessages !== undefined && typeof body.resetMessages !== "boolean")
    ) {
      return { status: 400, body: { error: "ルーム設定が不正です" } };
    }
    const existing = getRoom(id);
    if (!existing) return { status: 404, body: { error: "ルームが見つかりません" } };
    if (body.resetMessages === true) {
      // Mirror 1:1 Bot reset: stop live turns, cancel Code outbox/handoffs, then wipe member sessions
      // before clearing the shared transcript so attention/Code cannot report into an empty room.
      await stopRoomTurns(id);
      cancelPendingRoomHandoffs(id);
      await stopAllRoomCodeSessions(id);
      for (const memberId of existing.members) {
        const taskId = roomBotTaskId(id, memberId);
        if (getTask(taskId)) await resetTaskConversation(taskId);
      }
    } else if (body.members !== undefined) {
      const nextMembers = assertKnownRoomMembers(body.members as string[]);
      const removed = existing.members.filter((memberId) => !nextMembers.includes(memberId));
      for (const botId of removed) await detachBotFromRoomRuntime(id, botId);
    }
    const room = patchRoom(id, {
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.members !== undefined ? { members: body.members as string[] } : {}),
      ...(body.botRelayEnabled !== undefined ? { botRelayEnabled: body.botRelayEnabled as boolean } : {}),
      ...(body.codeAutoApprove !== undefined ? { codeAutoApprove: body.codeAutoApprove as boolean } : {}),
      ...(body.resetMessages !== undefined ? { resetMessages: body.resetMessages as boolean } : {}),
    });
    return room ? { status: 200, body: { room } } : { status: 404, body: { error: "ルームが見つかりません" } };
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return { status, body: { error: message } };
  }
}

/**
 * Delete one Room: stop its turns, cancel handoffs and Code sessions, then destroy the member tasks
 * before the room file goes. Every step is owner work, so the WebUI forwards it after the cutover.
 */
export async function handleRoomDelete(roomId: string): Promise<RoomAdminResult> {
  try {
    const id = roomId;
    if (!getRoom(id)) return { status: 404, body: { error: "ルームが見つかりません" } };
    // Same teardown as resetMessages: stop turns/handoffs/Code before destroying member tasks.
    await stopRoomTurns(id);
    cancelPendingRoomHandoffs(id);
    await stopAllRoomCodeSessions(id);
    for (const task of listTasks(true, "bot").filter((item) => item.id.endsWith(`:room:${id}`))) await destroyTask(task.id);
    return deleteRoom(id) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "ルームが見つかりません" } };
  } catch (error) {
    const { error: message, status } = jsonError(error);
    return { status, body: { error: message } };
  }
}
