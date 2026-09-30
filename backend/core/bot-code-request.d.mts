/** Bot and Room a Code task was delegated from, or null when it is not a Room origin. */
export function roomCodeOrigin(taskId: string | null | undefined): { botId: string; roomId: string } | null;

/** Whether the value is a 64-character lowercase hex request id. */
export function isCodeRequestId(value: unknown): boolean;

/**
 * Whether a Room Code request may still deliver its report. `isRoomStopRequest` decides
 * which user lines are stop requests.
 */
export function isRoomCodeRequestCurrent(input: {
  room: { messages: ReadonlyArray<{ id: string; role: string; text?: string; status?: string; botId?: string; conversation?: { requestId: string; participantIds: string[] } | null }>; members: readonly string[] } | null | undefined;
  request: {
    botId: string;
    room?: { id: string; responseId: string; conversation: { requestId: string } } | null;
  } | null | undefined;
  isRoomStopRequest: (text: string) => boolean;
}): boolean;

export const TERMINAL_CODE_REQUEST_STATES: readonly string[];

/** Whether the request still holds a claim (not delivered and not cancelled). */
export function isActiveCodeRequest(request: { state: string } | null | undefined): boolean;

/** The active, non-intervention request that already owns a Code task, newest first. */
export function selectActiveCodeRequestForTask<T extends {
  id: string; codeTaskId?: string | null; state: string; userIntervention?: boolean; queuedAt?: number;
}>(requests: readonly T[], codeTaskId: string): T | undefined;

/** Code tasks a Bot is still running for one origin, in the order the requests were read. */
export function runningCodeTaskIdsForOrigin<T extends {
  originTaskId: string; state: string; codeTaskId?: string | null; userIntervention?: boolean;
}>(requests: readonly T[], originTaskId: string): string[];

/** What one outbox scan does with a request this worker may act on. */
export function resolveOutboxScanAction(input: { state: string; isBusy: boolean }): "wait" | "requeue" | "start";

/** The Code task to abort when a request is cancelled, or null when nothing started. */
export function cancellationTargetForRequest(request: { state: string; codeTaskId?: string | null } | null | undefined): string | null;
