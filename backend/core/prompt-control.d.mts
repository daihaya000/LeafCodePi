export const STEER_STREAM_WAIT_MS: number;
export const STEER_STREAM_POLL_MS: number;

export type StreamingBehavior = "steer" | "followUp";
export type PromptImageInput = { mimeType: string; data: string };
export type PromptOptions = {
  source?: "extension";
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  streamingBehavior?: StreamingBehavior;
};

export function buildPromptOptions(input: {
  images?: PromptImageInput[];
  streamingBehavior?: StreamingBehavior;
  isStreaming: boolean;
  isHangRetry: boolean;
}): PromptOptions;
export function shouldBypassPromptChain(streamingBehavior: StreamingBehavior | undefined): boolean;
export function resolveStreamingBehaviorForPrompt(
  streamingBehavior: StreamingBehavior | undefined,
  isStreaming: boolean,
): StreamingBehavior | undefined;
export function shouldWaitForSteerStream(input: { isStreaming: boolean; promptActive: boolean }): boolean;
export function waitForSessionStreaming(
  isStreaming: () => boolean,
  stillActive: () => boolean,
  options?: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean>;
export function nextPromptEpoch(current: number | undefined): number;
export function isStaleHarnessPrompt(startedEpoch: number, currentEpoch: number): boolean;
export function clearSessionQueue(
  session: { clearQueue?: () => unknown },
  warn?: (message: string) => void,
): void;
export function isReasoningMandatoryError(error: unknown): boolean;

/** Which prompt gate refuses (or forwards) before any session work; null means proceed. */
export function resolvePromptGate(gates: {
  projectArchived: () => boolean;
  forwardToBotCode: () => boolean;
  leaseOwnedElsewhere: () => boolean;
}): "archived-project" | "forward-bot-code" | "lease-busy" | null;

/** Whether a Code task's prompt belongs to its Bot's worker. */
export function shouldForwardBotCodePrompt(input: {
  isBot: boolean;
  botId: string | null | undefined;
  botEnabled: unknown;
  leaseHeldElsewhere: boolean;
}): boolean;

/** Permission values a prompt should carry: a pinned option wins, Settings fill the gap only with a live session. */
export function resolvePromptPermissionOptions(input: {
  hasLive: boolean;
  optionPermissionMode: string | undefined;
  optionSkillPermission: string | undefined;
  updatedPermissionMode: string | undefined;
  updatedSkillPermission: string | undefined;
}): { permissionMode: string | undefined; skillPermission: string | undefined };

/** Whether the stored model must be rewritten for this request. */
export function shouldApplyPromptModelSelection(input: { hasOption: boolean; matches: boolean }): boolean;

/** Whether the stored effort level must be rewritten for this request. */
export function shouldApplyPromptThinkingLevel(input: {
  hasOption: boolean;
  modelChanged: boolean;
  taskLevel: string | undefined;
  optionLevel: string | undefined;
}): boolean;

/** Whether a resume may ignore this model/account selection failure. */
export function isRecoverableResumeSelectionError(error: unknown): boolean;

/** What the hang watch does when a prompt is queued: arm, keep the armed one, or disarm. */
export function resolveHangWatchQueueAction(input: {
  hasStreamingBehavior: boolean;
  isCodeResult: boolean;
  skipRearm: boolean;
}): "arm" | "keep" | "disarm";

/** Whether a prompt queued with skipRearm arms the watch at send time. */
export function shouldArmHangWatchAtSend(input: { skipRearm: boolean }): boolean;
