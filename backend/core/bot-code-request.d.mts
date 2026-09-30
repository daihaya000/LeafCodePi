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

/** The outcome/Goal Loop report a delivered Code result exposes. */
export function codeRequestPayload(request: { result?: string | null } | null | undefined): {
  outcome?: string;
  goalLoop?: unknown;
};

/** The stored result of a request the user stopped (existing object fields kept). */
export function userStoppedResult(result: string | null | undefined): string;

/** The event payload a Code request's state change publishes. */
export function codeSessionChangedPayload(input: {
  eventType: string;
  requestId: string;
  codeTaskId: string | null;
  state: string;
}): { type: "snapshot"; eventType: string; codeRequestId: string; codeTaskId: string | null; codeState: string };

/** What a completion request does for a request in this state. */
export function codeCompletionAction(input: { state: string; stoppedByUser: boolean }):
  "capture" | "stop-and-ready" | "stop-only" | "none";

/** The messages after a run's baseline; empty when the baseline left the transcript. */
export function codeResultBaselineMessages<T>(messages: readonly T[], baseline: string | null | undefined): T[];

/** The last assistant message of a run. */
export function codeResultLatestAssistant<T>(messages: readonly T[]): T | undefined;

/** The outcome word a captured run reports. */
export function codeResultOutcome(input: {
  hasTask: boolean;
  stoppedByUser: boolean;
  manualAborted: boolean;
  archived: boolean;
  taskError?: string | null;
  messageError?: string | null;
  goalLoopOutcome?: string | null;
  hasText: boolean;
}): string;

/** The stored output text and whether it was cut at the report limit. */
export function codeResultOutput(text: string | null | undefined, maxChars: number): { output: string; truncated: boolean };

/** How long a request waits before another delivery attempt. */
export const CODE_DELIVERY_RETRY_MS: number;

/** Whether a ready request may be delivered now. */
export function shouldAttemptCodeDelivery(input: {
  originBusy: boolean;
  nextAttemptAt: number | undefined;
  now: number;
}): boolean;

/** Whether a successful delivery may be written down. */
export function shouldConfirmCodeDelivery(input: { state: string }): boolean;

/** How long a settled request file is kept before the scan may delete it. */
export const CODE_REQUEST_RETENTION_MS: number;
/** How often the outbox is scanned. */
export const CODE_RELAY_TICK_MS: number;

/** Whether a request file may be deleted by the scan. */
export function shouldPruneCodeRequest(input: {
  isActive: boolean;
  fileMtimeMs: number | undefined;
  now: number;
}): boolean;

/** Whether a scan may start (one tick at a time). */
export function shouldStartCodeRelayTick(input: { ticking: boolean }): boolean;

/** The prompt a Bot may hand to Code, cut to the limit (code points; the ellipsis counts). */
export function truncateCodeReportRequest(prompt: string, maxChars: number): string;

/** The Goal Loop options a Bot tool call may carry, validated and clamped. */
export function parseGoalLoopInput(
  value: unknown,
  deps: {
    normalizeAcceptance: (value: unknown) => string[] | null;
    clampMaxTurns: (value: unknown, fallback: number) => number;
    clampCooldownSeconds: (value: unknown) => number;
    defaultMaxTurns: number;
  },
): { acceptance: string[] | null; maxTurns: number; cooldownSeconds: number; forceFullRun: boolean } | undefined;

/** The prompt bound a Bot tool call must respect. */
export const MAX_CODE_PROMPT_CHARS: number;
/** Cumulative cap on autonomous Code continuations. */
export const MAX_AUTO_CODE_CHAIN: number;

/** `taskId` refusal message, or null. */
export function codeTaskIdRefusal(input: { action: string; taskId: string | undefined }): string | null;
/** `goalLoop` refusal message, or null. */
export function codeGoalLoopRefusal(input: { action: string; hasGoalLoop: boolean }): string | null;
/** Reporting-gate refusal message, or null. */
export function codeReportingRefusal(input: {
  report: { userStopped?: boolean; room?: boolean; followUpStarted?: boolean } | null | undefined;
  action: string;
}): string | null;
/** Autonomous-continuation limit message, or null. */
export function codeAutoChainRefusal(input: { autoChain: number; maxChain: number }): string | null;
/** Prompt refusal message, or null. */
export function codePromptRefusal(input: { action: string; prompt: string | undefined }): string | null;

/** The state of the Code session a follow-up prompt targets. */
export function codeLinkedSessionState(input: {
  hasSession: boolean;
  archived: boolean;
  permissionDenied: boolean;
  busy: boolean;
}): "missing" | "archived" | "denied" | "busy" | "available";

/** The pre-launch refusal message, or null. */
export function codeLaunchRefusal(input: {
  botPermissionMode: string | null | undefined;
  isRoomRequest: boolean;
  roomRequestCurrent: boolean;
  action: string | undefined;
  linkedState?: string | undefined;
}): string | null;

/** The project refusal message, or null. */
export function codeProjectRefusal(input: {
  hasProjectId: boolean;
  hasProject: boolean;
  archived: boolean;
}): string | null;

/** The outbox row for a new Code request (optional parts omitted when empty). */
export function buildCodeRequestRecord(input: {
  id: string;
  botId: string;
  originTaskId: string;
  action: string;
  linkedTaskId?: string | null;
  projectId: string | null;
  goalLoop?: unknown;
  autoChain?: number;
  queuedAt: number;
  prompt: string;
  baseline?: string | null;
  room?: unknown;
  images?: readonly unknown[] | undefined;
}): Record<string, unknown>;

/** The summary of one request: the Bot panel fields plus the delivered outcome/report. */
export function codeRequestSummary(request: Record<string, unknown>): Record<string, unknown>;

/** The requests a Bot panel lists: its own, excluding user interventions, newest first. */
export function codeRequestSummaries(
  requests: ReadonlyArray<Record<string, unknown> & { botId?: string; userIntervention?: boolean; queuedAt?: number }>,
  botId: string,
): Array<Record<string, unknown>>;

/** The report a Bot turn produced for one Code request, or undefined when there is none. */
export function botCodeReportText(
  entries: readonly unknown[],
  requestId: string,
  codeResultType: string,
): string | undefined;

/** The requests that belong to one Room conversation turn. */
export function codeRequestsForRoomTurn<T extends {
  id: string;
  state: string;
  room?: { id: string; conversation?: { requestId: string } } | null;
}>(requests: readonly T[], options: {
  roomId: string;
  requestId: string;
  excludeRequestId?: string | undefined;
  activeOnly?: boolean;
}): T[];

/** The distinct Code sessions a teardown must stop, in read order. */
export function codeStopTargets<T extends { codeTaskId?: string | null }>(
  requests: readonly T[],
  matches: (request: T) => boolean,
): string[];

/** Whether a Code session still needs stopping. */
export function shouldStopCodeSession(input: {
  hasTask: boolean;
  archived: boolean;
  working: boolean;
  goalLoopOwned: boolean;
}): boolean;

/** The launch request still running one Code task (reverse lookup), or undefined. */
export function codeRequestForCodeTask<T extends {
  codeTaskId?: string | null;
  state: string;
  userIntervention?: boolean;
}>(requests: readonly T[], codeTaskId: string): T | undefined;

/** The report-turn state kept for one origin while a Code result is delivered. */
export function reportingStateForRequest(request: {
  room?: unknown;
  stoppedByUser?: boolean;
  autoChain?: number;
}): { room: boolean; followUpStarted: boolean; userStopped: boolean; autoChain: number };

/** Records whether a follow-up attempt consumed the report turn's follow-up slot. */
export function markFollowUpAttempt(
  report: { followUpStarted: boolean } | null | undefined,
  outcome: { succeeded: boolean },
): void;

/** Whether a user-intervention dispatch has a Code session to target. */
export function shouldDispatchUserIntervention(input: { hasCodeTaskId: boolean }): boolean;

/** Whether a dispatch must cancel because its Code task is gone or archived. */
export function shouldCancelCodeDispatch(input: { hasTask: boolean; archived: boolean }): boolean;

/** The state a finished dispatch records. */
export function codeDispatchResultState(input: { succeeded: boolean }): "delivered" | "queued";

/** Why a Bot may not adopt a user-started Code task, or null. */
export function adoptSupervisionRefusal(input: {
  hasTask: boolean;
  kind: string | undefined;
  hasBotId: boolean;
  roomOrigin: boolean;
  supervisorBotId: string | null | undefined;
  botId: string;
  working: boolean;
  busy: boolean;
}): string | null;

/** Why a Bot may not release a supervised Code task, or null. */
export function releaseSupervisionRefusal(input: {
  kind: string | undefined;
  hasBotId: boolean;
  roomOrigin: boolean;
  supervisorBotId: string | null | undefined;
}): string | null;
