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

/**
 * The gate ladder a prompt passes before any session work, in this order: an archived
 * project, then Bot-code forwarding, then a lease held by another worker. Each check is
 * a thunk so a prompt that is rejected early never performs the later lookups (the lease
 * checks read files). "forward-bot-code" is not a refusal: the Bot's own worker holds the
 * lease, so the prompt is queued for it instead of being rejected.
 */
export function resolvePromptGate({ projectArchived, forwardToBotCode, leaseOwnedElsewhere }) {
  if (projectArchived()) return "archived-project";
  if (forwardToBotCode()) return "forward-bot-code";
  if (leaseOwnedElsewhere()) return "lease-busy";
  return null;
}

/**
 * Whether a Code task's prompt belongs to its Bot's worker. A Bot task, a missing Bot
 * record, a disabled Bot or a lease this process owns all mean no forwarding.
 */
export function shouldForwardBotCodePrompt({ isBot, botId, botEnabled, leaseHeldElsewhere }) {
  return Boolean(isBot !== true && botId && botEnabled && leaseHeldElsewhere === true);
}

/**
 * The permission values a prompt should carry. An option the caller pinned always wins;
 * otherwise the Settings-derived update fills the gap, but only while the task already has
 * a live session. A cold task gets its permissions from `ensureLive` instead, which applies
 * Settings while the session is created.
 */
export function resolvePromptPermissionOptions({
  hasLive,
  optionPermissionMode,
  optionSkillPermission,
  updatedPermissionMode,
  updatedSkillPermission,
}) {
  return {
    permissionMode: optionPermissionMode === undefined && hasLive === true ? updatedPermissionMode : undefined,
    skillPermission: optionSkillPermission === undefined && hasLive === true ? updatedSkillPermission : undefined,
  };
}

/** A stored model is only rewritten when the request differs from what the task already has. */
export function shouldApplyPromptModelSelection({ hasOption, matches }) {
  return hasOption === true && matches !== true;
}

/**
 * The effort level is rewritten when the model just changed (the old level belonged to the
 * previous model) or when it differs from the stored one.
 */
export function shouldApplyPromptThinkingLevel({ hasOption, modelChanged, taskLevel, optionLevel }) {
  if (hasOption !== true) return false;
  return modelChanged === true || taskLevel !== optionLevel;
}

/**
 * A resume may carry a model/account the user has since deleted: those 400/404 selection
 * failures are recoverable, everything else must fail the prompt.
 */
export function isRecoverableResumeSelectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
  return (
    (status === 400 || status === 404) &&
    (message === "モデルが見つかりません" || message === "アカウントが見つかりません")
  );
}

/**
 * What the hang watch does when a prompt is queued. A steer/follow-up must not replace the
 * hang-watch resume prompt with its short text (that would resume the wrong turn after a
 * hang), and a demoted interrupt waits until the serial turn actually starts — both keep
 * the armed watch. Internal Code results are retried by their durable outbox and are never
 * replayed as user input, so the watch is disarmed. Everything else arms.
 */
export function resolveHangWatchQueueAction({ hasStreamingBehavior, isCodeResult, skipRearm }) {
  if (isCodeResult === true) return "disarm";
  if (hasStreamingBehavior === true || skipRearm === true) return "keep";
  return "arm";
}

/** A prompt queued with `skipRearm` arms the watch at send time, once the serial turn starts. */
export function shouldArmHangWatchAtSend({ skipRearm }) {
  return skipRearm === true;
}

/**
 * How one prompt reaches the session. Internal turns are delivered as hidden custom
 * messages so the transcript keeps the internal cause, while a normal prompt goes through
 * the SDK prompt path. The precedence matches the transcript contract: a Code result is
 * never replayed as user input, and a provider/transport recovery is not shown as a user
 * turn. The custom type names are the caller's (they are part of the transcript format).
 */
export function resolvePromptSendKind({ isCodeResult, isProviderFallback, isTransportRecovery }) {
  if (isCodeResult === true) return "code-result";
  if (isProviderFallback === true) return "provider-fallback";
  if (isTransportRecovery === true) return "transport-recovery";
  return "prompt";
}

/** The custom message type each internal send kind uses, or null for a plain prompt. */
export function promptSendCustomType(kind, customTypes) {
  if (kind === "code-result") return customTypes.codeResult;
  if (kind === "provider-fallback") return customTypes.providerFallback;
  if (kind === "transport-recovery") return customTypes.transportRecovery;
  return null;
}

/**
 * A prompt error is ignored when the turn was aborted by the user: the abort path already
 * recorded the outcome, so marking the task as errored here would report a failure for a
 * deliberate stop.
 */
export function shouldIgnorePromptError({ isAbortMessage, hasManualAbort }) {
  return isAbortMessage === true && hasManualAbort === true;
}

/**
 * Whether a prompt may be re-routed to another account before it is sent. Routing needs
 * the task to already have a provider and model, a session that is not streaming, at
 * least one user turn to continue (or an active Goal Loop turn, which has its own
 * history), a provider that routes through integrated accounts, and an account the user
 * did not pin explicitly — a pinned account is never replaced. The caller also decides
 * whether re-routing was requested at all.
 */
export function canRouteAccountForPrompt({
  reroute,
  hasProviderId,
  hasModelId,
  isStreaming,
  isGoalLoopTurn,
  hasUserMessage,
  isAccountRoutingProvider,
  accountRoutingMode,
  accountIdExplicit,
}) {
  return Boolean(
    reroute === true &&
      hasProviderId === true &&
      hasModelId === true &&
      isStreaming !== true &&
      (isGoalLoopTurn === true || hasUserMessage === true) &&
      isAccountRoutingProvider === true &&
      accountRoutingMode === "integrated" &&
      accountIdExplicit !== true,
  );
}

/**
 * The same eligibility re-checked inside the route lock, where a pin or a streaming
 * session that appeared while waiting must stop the routing. Here the caller has already
 * decided that routing is wanted, so only the remaining conditions are tested.
 */
export function stillEligibleForAccountRouting({
  hasProviderId,
  hasModelId,
  isAccountRoutingProvider,
  accountRoutingMode,
  accountIdExplicit,
  isStreaming,
  isGoalLoopTurn,
  hasUserMessage,
}) {
  return Boolean(
    hasProviderId === true &&
      hasModelId === true &&
      isAccountRoutingProvider === true &&
      accountRoutingMode === "integrated" &&
      accountIdExplicit !== true &&
      isStreaming !== true &&
      (isGoalLoopTurn === true || hasUserMessage === true),
  );
}

/**
 * Whether the prompt's subagent permission must be pushed onto the session: a pinned option
 * always is, and a Code task follows Settings; a Bot task without a pinned value keeps its own
 * Bot settings.
 */
export function shouldApplyPromptSubagentPermission({ hasOption, isBot }) {
  return hasOption === true || isBot !== true;
}

/**
 * Whether an interrupt must be demoted to a normal prompt. A steer/follow-up that finds no
 * streaming turn to steer (the stream already ended or never opened) is re-queued as the next
 * serial turn instead of being dropped; `finalBehavior` is the resolved streaming behavior.
 */
export function shouldDemoteInterrupt({ hasStreamingBehavior, finalBehavior }) {
  return hasStreamingBehavior === true && !finalBehavior;
}

/**
 * Whether a steer/follow-up must wait for the stream to open before it is sent. Waiting is
 * only needed while the accepted turn is active but not yet streaming — otherwise the steer
 * would be serialized onto the prompt chain as a post-turn prompt.
 */
export function shouldWaitForSteerStreamBeforeSend({ hasStreamingBehavior, isStreaming }) {
  return hasStreamingBehavior === true && isStreaming !== true;
}

/**
 * The thinking level to fall back to when a model rejects thinking-off. Models that cannot
 * disable thinking expose their levels without "off"; the lowest of those is used, and a model
 * with no levels at all falls back to "minimal" (the level such models accept).
 */
export function reasoningFallbackLevel(levels) {
  const usable = Array.isArray(levels) ? levels.filter((level) => level !== "off") : [];
  return usable[0] ?? "minimal";
}

/**
 * Whether a failed send is retried once with a higher thinking level. Only the provider's
 * "reasoning is mandatory" 400 qualifies, and only once per turn: the second failure is the
 * real error.
 */
export function shouldRetryWithReasoningFallback({ isReasoningMandatory, alreadyTried }) {
  return isReasoningMandatory === true && alreadyTried !== true;
}

/**
 * Whether the prompt chain must hand the Code result to its durable outbox. A request without
 * an id has no outbox entry, and while the hang watchdog is resolving, the resume turn delivers
 * the result itself — completing here would capture it twice.
 */
export function shouldCompleteCodeRequestAfterPrompt({ hasCodeRequestId, hangWatchState }) {
  return hasCodeRequestId === true && hangWatchState !== "resolving";
}
