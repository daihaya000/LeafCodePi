import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
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
const roomAdminUnknown = (): RoomAdminResult => ({ status: 503, body: { error: "Room設定の処理結果を確認できません" } });

/** Relay / standing Code approval are privileged mutations: the WebUI token must allow them. */
export function hasPrivilegedRoomMutation(body: RoomAdminBody | null): boolean {
  return body?.botRelayEnabled !== undefined || body?.codeAutoApprove !== undefined;
}

/**
 * One Room settings change (PATCH), including the destructive teardown of `resetMessages` and the
 * session detach of a removed member.
 *
 * Backend-only ladder for stopping turns, resetting member conversations and detaching a Bot.
 * Both Backend transports use this owner entry. The authenticated caller has already checked
 * trusted WebUI authorization for a privileged mutation.
 */
export async function handleRoomPatch(roomId: string, body: RoomAdminBody | null): Promise<RoomAdminResult> {
  assertConfigurationOwner();
  let effectsStarted = false;
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
    // Validate all requested members before reset/detach can make a partial change.
    const nextMembers = body.members === undefined ? undefined : assertKnownRoomMembers(body.members as string[]);
    if (body.resetMessages === true) {
      effectsStarted = true;
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
      const removed = existing.members.filter((memberId) => !nextMembers!.includes(memberId));
      for (const botId of removed) { effectsStarted = true; await detachBotFromRoomRuntime(id, botId); }
    }
    effectsStarted = true;
    const room = patchRoom(id, {
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.members !== undefined ? { members: body.members as string[] } : {}),
      ...(body.botRelayEnabled !== undefined ? { botRelayEnabled: body.botRelayEnabled as boolean } : {}),
      ...(body.codeAutoApprove !== undefined ? { codeAutoApprove: body.codeAutoApprove as boolean } : {}),
      ...(body.resetMessages !== undefined ? { resetMessages: body.resetMessages as boolean } : {}),
    });
    return room ? { status: 200, body: { room } } : roomAdminUnknown();
  } catch (error) {
    if (effectsStarted) return roomAdminUnknown();
    const { error: message, status } = jsonError(error);
    return { status, body: { error: status >= 500 ? "Room設定の処理結果を確認できません" : message } };
  }
}

/**
 * Delete one Room: stop its turns, cancel handoffs and Code sessions, then destroy the member tasks
 * before the room file goes. Next never runs this teardown; both Backend transports use this entry.
 */
export async function handleRoomDelete(roomId: string): Promise<RoomAdminResult> {
  assertConfigurationOwner();
  let effectsStarted = false;
  try {
    const id = roomId;
    if (!getRoom(id)) return { status: 404, body: { error: "ルームが見つかりません" } };
    // Same teardown as resetMessages: stop turns/handoffs/Code before destroying member tasks.
    effectsStarted = true;
    await stopRoomTurns(id);
    cancelPendingRoomHandoffs(id);
    await stopAllRoomCodeSessions(id);
    for (const task of listTasks(true, "bot").filter((item) => item.id.endsWith(`:room:${id}`))) await destroyTask(task.id);
    return deleteRoom(id) ? { status: 200, body: { ok: true } } : roomAdminUnknown();
  } catch (error) {
    if (effectsStarted) return roomAdminUnknown();
    const { error: message, status } = jsonError(error);
    return { status, body: { error: status >= 500 ? "Room設定の処理結果を確認できません" : message } };
  }
}
