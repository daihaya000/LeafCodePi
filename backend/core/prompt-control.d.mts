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
