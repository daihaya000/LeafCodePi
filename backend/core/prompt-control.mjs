export const STEER_STREAM_WAIT_MS = 30_000;
export const STEER_STREAM_POLL_MS = 50;

/** Build SDK prompt options without owning the session or its stream. */
export function buildPromptOptions({ images, streamingBehavior, isStreaming, isHangRetry }) {
  const options = {};
  if (isHangRetry) options.source = "extension";
  if (images?.length) {
    options.images = images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
  }
  if (streamingBehavior) options.streamingBehavior = streamingBehavior;
  // Hang retries must start a fresh turn after abort, never inject as followUp
  // if isStreaming is still briefly true.
  else if (isStreaming && !isHangRetry) options.streamingBehavior = "followUp";
  return options;
}

/** Only steer/follow-up injects skip the serial prompt chain. */
export function shouldBypassPromptChain(streamingBehavior) {
  return Boolean(streamingBehavior);
}

/** A late interrupt becomes a no-op once the current turn is no longer streaming. */
export function resolveStreamingBehaviorForPrompt(streamingBehavior, isStreaming) {
  return isStreaming ? streamingBehavior : undefined;
}

/** Wait only while the accepted prompt is still active and not yet streaming. */
export function shouldWaitForSteerStream({ isStreaming, promptActive }) {
  return !isStreaming && promptActive;
}

/** Time is read at call time so fake clocks and timers remain effective. */
export async function waitForSessionStreaming(isStreaming, stillActive, options) {
  if (isStreaming()) return true;
  const timeoutMs = options?.timeoutMs ?? STEER_STREAM_WAIT_MS;
  const pollMs = options?.pollMs ?? STEER_STREAM_POLL_MS;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillActive()) return false;
    await sleep(pollMs);
    if (isStreaming()) return true;
  }
  return isStreaming();
}

/** Monotonic invalidation token for an accepted prompt. */
export function nextPromptEpoch(current) {
  return (current || 0) + 1;
}

export function isStaleHarnessPrompt(startedEpoch, currentEpoch) {
  return startedEpoch !== currentEpoch;
}

/** abort() leaves SDK queues behind; drop them so stale work cannot drain later. */
export function clearSessionQueue(session, warn = console.warn) {
  try {
    session.clearQueue?.();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`[abort] clearQueue failed: ${reason}`);
  }
}

/** Provider 400 for models that cannot disable thinking. */
export function isReasoningMandatoryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /reasoning is mandatory/i.test(message);
}
