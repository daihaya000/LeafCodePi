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
