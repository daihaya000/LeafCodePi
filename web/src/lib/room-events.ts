import type { RoomAttention, RoomDto } from "./types";

function codeRequestProgressKey(request: NonNullable<RoomDto["messages"][number]["codeRequests"]>[number]): string {
  const todo = request.todoProgress;
  const loop = request.goalLoopSummary;
  return [
    request.id,
    request.taskId ?? "",
    request.state,
    request.activity ?? "",
    todo ? `${todo.completed}/${todo.total}` : "",
    loop ? `${loop.status}:${loop.turnCount}/${loop.maxTurns}` : "",
  ].join(":");
}

/**
 * Change key for the room stream. Every room write bumps `updatedAt`, so a task event that
 * changed nothing costs a comparison instead of serialising the whole transcript. The last
 * message text and outcome are included because two writes can share one millisecond.
 * Per-card Code progress (activity / ToDo / Goal Loop) is included so folded cards refresh
 * even when only those fields change within the same millisecond.
 */
export function roomSnapshotSignature(room: RoomDto, attention: RoomAttention[]): string {
  const last = room.messages.at(-1);
  const waiting = attention.map((item) => `${item.botId}:${item.permission?.id ?? ""}:${item.question?.id ?? ""}`).join(",");
  return [
    room.updatedAt,
    room.messages.length,
    last?.id ?? "",
    last?.status ?? "",
    JSON.stringify(last?.text ?? ""),
    last?.codeState ?? "",
    room.messages.map((message) => message.codeActivity ?? "").join(","),
    room.messages.flatMap((message) => (message.codeRequests ?? []).map(codeRequestProgressKey)).join(","),
    room.lastOutcome?.kind ?? "",
    room.members.join(","),
    waiting,
  ].join("|");
}
