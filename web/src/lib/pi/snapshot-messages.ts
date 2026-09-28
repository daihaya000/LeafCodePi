import {
  isAgentSwitchMarker,
  isGoalLoopTurnMarker,
  isIntercomMessageMarker,
  piRawMessageProjectsToUi,
  projectPiMessages,
} from "@/lib/pi/messages";
import {
  snapshotThroughput,
  type ThroughputTiming,
} from "@/lib/token-throughput";
import type { UiMessage } from "@/lib/types";

type PiModule = typeof import("@earendil-works/pi-coding-agent");
type AgentSession = Awaited<
  ReturnType<PiModule["createAgentSession"]>
>["session"];

type SnapshotProjectionCache = {
  source: readonly unknown[];
  length: number;
  last: unknown;
  /** True only when a full projection may be reused without re-reading the stream. */
  projectedFresh: boolean;
  /** Fingerprint of the in-history streaming message used for the cached projection. */
  streamingFingerprint: string | null;
  projected: UiMessage[];
};

type BranchProjectionCache = {
  leafId: string | null;
  raw: unknown[];
  entryIdByMessage: Map<unknown, string>;
  /** True only when a full projection may be reused without re-reading the stream. */
  projectedFresh: boolean;
  /** Fingerprint of the in-history streaming message used for the cached projection. */
  streamingFingerprint: string | null;
  projected: UiMessage[];
};

type ProjectionCache = SnapshotProjectionCache | BranchProjectionCache;

/** Stable session history is reused between 100ms SSE snapshots. */
const snapshotProjectionCache = new WeakMap<object, SnapshotProjectionCache>();
/** Full current-branch history survives compaction and is reused between snapshots. */
const branchProjectionCache = new WeakMap<object, BranchProjectionCache>();
/** Reuse the single-row input for latest-only throughput projection. */
const latestOnlyProjectionCache = new WeakMap<object, { last: UiMessage; projected: UiMessage[] }>();

function isPlainUserMessage(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    Object.prototype.hasOwnProperty.call(item, "role") &&
    (item as { role?: unknown }).role === "user"
  );
}

/** A streamed assistant can be a copy of the branch entry, not the same object. */
function sameAssistantGeneration(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  if (left.role !== "assistant" || right.role !== "assistant") return false;
  if (
    typeof left.timestamp !== "number" ||
    !Number.isFinite(left.timestamp) ||
    left.timestamp !== right.timestamp
  ) {
    return false;
  }
  for (const key of ["api", "provider", "model"] as const) {
    if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

/** Detect in-place stream mutations without reprojecting the whole history. */
function fingerprintStreamingMessage(streaming: unknown): string | null {
  try {
    const fingerprint = JSON.stringify(streaming);
    return typeof fingerprint === "string" ? fingerprint : null;
  } catch {
    // A non-serializable stream cannot be safely reused.
    return null;
  }
}

function cachedSourceLength(cache: ProjectionCache | undefined): number | undefined {
  if (!cache) return undefined;
  return "source" in cache ? cache.source.length : cache.raw.length;
}

/** Replace only the latest row in a cached full projection. */
function patchCachedProjection(
  cache: ProjectionCache | undefined,
  latest: UiMessage | undefined,
): UiMessage[] | null {
  if (!cache || !latest) return null;
  const index = cache.projected.findLastIndex((message) => message.id === latest.id);
  if (index < 0) return null;
  const projected = cache.projected.slice();
  projected[index] = latest;
  return projected;
}

/** Return the latest branch assistant if it represents the active stream. */
function inHistoryStreamingIndex(raw: unknown[], streaming: unknown): number {
  if (typeof streaming !== "object" || streaming === null) return -1;
  const index = raw.findLastIndex((item) =>
    typeof item === "object" && item !== null && (item as { role?: unknown }).role === "assistant",
  );
  return index >= 0 && sameAssistantGeneration(raw[index], streaming) ? index : -1;
}

/** Find the current Goal Loop marker without scanning past a manual user turn. */
function latestGoalLoopMarkerIndex(raw: unknown[], endIndex = raw.length - 1): number {
  for (let index = Math.min(endIndex, raw.length - 1); index >= 0; index -= 1) {
    const item = raw[index];
    if (isGoalLoopTurnMarker(item)) return index;
    if (isPlainUserMessage(item)) return -1;
  }
  return -1;
}

/** Keep the intercom marker when projecting only the latest streaming message. */
function latestIntercomMarkerIndex(raw: unknown[], endIndex = raw.length - 1): number {
  for (let index = Math.min(endIndex, raw.length - 1); index >= 0; index -= 1) {
    const item = raw[index];
    if (isIntercomMessageMarker(item)) return index;
    if (
      isPlainUserMessage(item) ||
      (typeof item === "object" &&
        item !== null &&
        Object.prototype.hasOwnProperty.call(item, "customType"))
    ) return -1;
  }
  return -1;
}

function latestContextMarkerIndexes(raw: unknown[], endIndex = raw.length - 1): number[] {
  return [
    latestGoalLoopMarkerIndex(raw, endIndex),
    latestIntercomMarkerIndex(raw, endIndex),
  ]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
}

const finalizedThroughputCache = new WeakMap<
  UiMessage,
  { timing: ThroughputTiming; projected: UiMessage }
>();
const appliedThroughputArrayCache = new WeakMap<UiMessage[], UiMessage[]>();

/** throughput timing をメッセージへ反映（tok/s + 実測の応答所要時間）。 */
export function applyThroughput(
  messages: UiMessage[],
  throughputByStartedAt: Map<number, ThroughputTiming>,
): UiMessage[] {
  if (throughputByStartedAt.size === 0) return messages;
  const nowMs = Date.now();
  const previous = appliedThroughputArrayCache.get(messages);
  const baseline = previous?.length === messages.length ? previous : messages;
  const project = (message: UiMessage): UiMessage => {
    if (message.role !== "assistant") return message;
    const timing = throughputByStartedAt.get(message.createdAt);
    if (!timing) return message;
    const cached = timing.lastTokenAtMs != null
      ? finalizedThroughputCache.get(message)
      : undefined;
    if (
      cached &&
      cached.timing.startedAtMs === timing.startedAtMs &&
      cached.timing.firstTokenAtMs === timing.firstTokenAtMs &&
      cached.timing.lastTokenAtMs === timing.lastTokenAtMs &&
      cached.timing.outputTokens === timing.outputTokens &&
      cached.timing.outputTokensPartial === timing.outputTokensPartial &&
      cached.timing.charCount === timing.charCount
    ) return cached.projected;
    // 応答全体の所要時間（思考＋生成、TTFT 込み）。Pi の assistant timestamp は
    // 生成「開始」時刻のため、直前レコードとの差分では常に 0s になる —
    // 実測 lastToken を使う（応答完了後は永続化された値で復元）。
    const responseDurationMs = Math.max(
      0,
      (timing.lastTokenAtMs ?? nowMs) - timing.startedAtMs,
    );
    const snap = snapshotThroughput(timing, nowMs);
    let projected: UiMessage;
    if (!snap || snap.tokensPerSecond === null) {
      projected = responseDurationMs > 0 && message.responseDurationMs !== responseDurationMs
        ? { ...message, responseDurationMs }
        : message;
    } else if (
      message.outputTokens === snap.outputTokens &&
      message.tokensPerSecond === snap.tokensPerSecond &&
      message.tokensPerSecondDecode === snap.decodePhase &&
      (responseDurationMs <= 0 || message.responseDurationMs === responseDurationMs)
    ) {
      projected = message;
    } else {
      projected = {
        ...message,
        outputTokens: snap.outputTokens,
        tokensPerSecond: snap.tokensPerSecond,
        tokensPerSecondDecode: snap.decodePhase,
        ...(responseDurationMs > 0 ? { responseDurationMs } : {}),
      };
    }
    // In-progress timing depends on nowMs; snapshot values so in-place updates invalidate the cache.
    if (timing.lastTokenAtMs != null) {
      finalizedThroughputCache.set(message, { timing: { ...timing }, projected });
    }
    return projected;
  };
  let changed: UiMessage[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const projected = project(messages[index]!);
    if (projected === baseline[index]) continue;
    changed ??= baseline.slice();
    changed[index] = projected;
  }
  const result = changed ?? baseline;
  appliedThroughputArrayCache.set(messages, result);
  return result;
}

export type MessageAccountContext = {
  /** 現在のセッションアカウント（null = 既定）。 */
  accountId: string | null;
  /** 一度記録したメッセージのアカウント。セッション置き換え後も過去の値を保持する。 */
  byMessageId: Map<string, string>;
  /** 現在のセッションエージェント（null = 既定）。 */
  agentName?: string | null;
  /** 一度記録したメッセージのエージェント。セッション置き換え後も過去の値を保持する。 */
  agentByMessageId?: Map<string, string | null>;
};

/** アシスタントメッセージへ生成時のアカウントを記録する（初回のみ記録、以降は保持）。 */
export function applyMessageAccountIds(
  messages: UiMessage[],
  context: MessageAccountContext,
): UiMessage[] {
  const { accountId, byMessageId } = context;
  if (!accountId && byMessageId.size === 0) return messages;
  let result: UiMessage[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    let recorded = byMessageId.get(message.id);
    if (recorded === undefined && accountId) {
      recorded = accountId;
      byMessageId.set(message.id, recorded);
    }
    if (!recorded || message.accountId === recorded) continue;
    if (!result) result = messages.slice();
    result[index] = { ...message, accountId: recorded };
  }
  return result ?? messages;
}

/** アシスタントメッセージへ生成時のエージェントを記録する（初回のみ記録、以降は保持）。 */
export function applyMessageAgentIds(
  messages: UiMessage[],
  context: MessageAccountContext,
): UiMessage[] {
  const { agentName, agentByMessageId } = context;
  if (!agentByMessageId) return messages;
  let result: UiMessage[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    let recorded = agentByMessageId.get(message.id);
    if (recorded === undefined) {
      recorded = message.agent?.trim() || agentName?.trim() || null;
      agentByMessageId.set(message.id, recorded);
    }
    if (recorded === (message.agent?.trim() || null)) continue;
    if (!result) result = messages.slice();
    result[index] = recorded ? { ...message, agent: recorded } : { ...message, agent: undefined };
  }
  return result ?? messages;
}

export function snapshotMessages(
  session: AgentSession,
  throughputByStartedAt?: Map<number, ThroughputTiming>,
  toolStartedAt?: Map<string, number>,
  toolEndedAt?: Map<string, number>,
  toolPartialOutputByCallId?: Map<string, string>,
  latestOnly = false,
  accountContext?: MessageAccountContext,
): UiMessage[] {
  const stored: unknown[] = Array.isArray(session.messages)
    ? session.messages
    : [];
  const branchLeafId = session.sessionManager.getLeafId();
  const cachedBranch = branchProjectionCache.get(session);
  let useBranchHistory = false;
  let branchCacheHit = false;
  let historyRaw: unknown[] = stored;
  let entryIdByMessage = new Map<unknown, string>();

  if (cachedBranch?.leafId === branchLeafId) {
    useBranchHistory = true;
    branchCacheHit = cachedBranch.projectedFresh;
    historyRaw = cachedBranch.raw;
    entryIdByMessage = cachedBranch.entryIdByMessage;
  } else {
    const branch = session.sessionManager.getBranch();
    if (branch.length > 0) {
      useBranchHistory = true;
      entryIdByMessage = new Map<unknown, string>();
      historyRaw = [];
      for (const entry of branch) {
        if (entry.type === "message") {
          entryIdByMessage.set(entry.message, entry.id);
          historyRaw.push(entry.message);
          continue;
        }
        if (entry.type === "custom_message") {
          const timestamp = Date.parse(entry.timestamp);
          const message = {
            id: entry.id,
            role: "custom" as const,
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
          };
          if (
            !piRawMessageProjectsToUi(message) &&
            !isGoalLoopTurnMarker(message) &&
            !isAgentSwitchMarker(message) &&
            !isIntercomMessageMarker(message)
          ) continue;
          entryIdByMessage.set(message, entry.id);
          historyRaw.push(message);
          continue;
        }
        if (entry.type !== "compaction") continue;
        const timestamp = Date.parse(entry.timestamp);
        historyRaw.push({
          id: entry.id,
          role: "compactionSummary" as const,
          timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
        });
      }
    }
  }
  const streaming = session.agent.state.streamingMessage;
  const streamingHistoryIndex = inHistoryStreamingIndex(historyRaw, streaming);
  const streamingInHistory =
    streamingHistoryIndex >= 0 ||
    (streaming != null &&
      (useBranchHistory ? entryIdByMessage.has(streaming) : stored.includes(streaming)));
  if (streamingHistoryIndex >= 0 && historyRaw[streamingHistoryIndex] !== streaming) {
    const branchMessage = historyRaw[streamingHistoryIndex];
    const entryId = entryIdByMessage.get(branchMessage);
    historyRaw = historyRaw.slice();
    historyRaw[streamingHistoryIndex] = streaming;
    if (entryId !== undefined) {
      entryIdByMessage = new Map(entryIdByMessage);
      entryIdByMessage.set(streaming, entryId);
    }
  }
  const streamingRole =
    streaming && typeof streaming === "object"
      ? (streaming as { role?: unknown }).role
      : undefined;
  const canAppendStreaming = Boolean(
    streaming && !streamingInHistory && streamingRole !== "toolResult",
  );

  const projectWithEntryIds = (
    raw: unknown[],
    indexOffset = 0,
  ): UiMessage[] => {
    const result = projectPiMessages(raw, indexOffset);
    if (entryIdByMessage.size === 0) return result;
    // Keep projected part ids derived from msg-N; replace only the row id needed for rewind.
    let projectedIndex = 0;
    for (const item of raw) {
      if (!piRawMessageProjectsToUi(item)) continue;
      const entryId = entryIdByMessage.get(item);
      const projected = result[projectedIndex];
      if (entryId && projected) result[projectedIndex] = { ...projected, id: entryId };
      projectedIndex++;
    }
    return result;
  };

  const projectLatestWithEntryIds = (raw: unknown[]): UiMessage[] => {
    const latestIndex = raw.findLastIndex(piRawMessageProjectsToUi);
    if (latestIndex < 0) return [];
    const markerIndexes = latestContextMarkerIndexes(raw, latestIndex);
    const startIndex = markerIndexes.length > 0 ? markerIndexes[0]! : latestIndex;
    return projectWithEntryIds(raw.slice(startIndex), startIndex);
  };

  let projected: UiMessage[];
  if (!streaming || canAppendStreaming) {
    if (useBranchHistory) {
      if (branchCacheHit) {
        projected = cachedBranch!.projected;
      } else {
        projected = projectWithEntryIds(historyRaw);
        branchProjectionCache.set(session, {
          leafId: branchLeafId,
          raw: historyRaw,
          entryIdByMessage,
          projectedFresh: true,
          streamingFingerprint: null,
          projected,
        });
      }
    } else {
      const cached = snapshotProjectionCache.get(session);
      const last = stored[stored.length - 1];
      if (
        cached?.source === stored &&
        cached.length === stored.length &&
        cached.last === last &&
        cached.projectedFresh
      ) {
        projected = cached.projected;
      } else {
        projected = projectWithEntryIds(historyRaw);
        snapshotProjectionCache.set(session, {
          source: stored,
          length: stored.length,
          last,
          projectedFresh: true,
          streamingFingerprint: null,
          projected,
        });
      }
    }
    if (canAppendStreaming) {
      const markerIndexes = latestContextMarkerIndexes(historyRaw);
      const markerMessages = markerIndexes.map((index) => historyRaw[index]);
      const streamingProjection = projectPiMessages(
        [...markerMessages, streaming],
        historyRaw.length - markerMessages.length,
      ).at(-1);
      if (streamingProjection) {
        projected = latestOnly
          ? [streamingProjection]
          : projected.concat(streamingProjection);
      }
    }
  } else if (latestOnly && streamingInHistory) {
    // The streaming object can be present in session.messages while it is
    // mutated. Project only the final independent message and its trailing
    // tool results; reprojecting the whole branch defeats delta throttling.
    const latestProjection = projectLatestWithEntryIds(historyRaw);
    const latest = latestProjection.at(-1);
    const cached = useBranchHistory
      ? cachedBranch
      : snapshotProjectionCache.get(session);
    const patched =
      cachedSourceLength(cached) === historyRaw.length
        ? patchCachedProjection(cached, latest)
        : null;
    const fingerprint = fingerprintStreamingMessage(streaming);
    projected = latestProjection;
    if (useBranchHistory) {
      branchProjectionCache.set(session, {
        leafId: branchLeafId,
        raw: historyRaw,
        entryIdByMessage,
        projectedFresh: patched !== null && fingerprint !== null,
        streamingFingerprint: patched !== null ? fingerprint : null,
        projected: patched ?? cachedBranch?.projected ?? [],
      });
    } else {
      snapshotProjectionCache.set(session, {
        source: stored,
        length: stored.length,
        last: stored[stored.length - 1],
        projectedFresh: patched !== null && fingerprint !== null,
        streamingFingerprint: patched !== null ? fingerprint : null,
        projected: patched ?? cached?.projected ?? [],
      });
    }
  } else {
    const raw = streamingInHistory ? historyRaw : [...historyRaw, streaming];
    if (streamingInHistory) {
      const cached = useBranchHistory
        ? cachedBranch
        : snapshotProjectionCache.get(session);
      const fingerprint = fingerprintStreamingMessage(streaming);
      const canReuse =
        cachedSourceLength(cached) === historyRaw.length &&
        cached?.projectedFresh === true &&
        fingerprint !== null &&
        cached.streamingFingerprint === fingerprint;
      projected = canReuse ? cached!.projected : projectWithEntryIds(raw);
      if (useBranchHistory) {
        branchProjectionCache.set(session, {
          leafId: branchLeafId,
          raw: historyRaw,
          entryIdByMessage,
          // A full read is reusable only until the next full read or mutation.
          projectedFresh: false,
          streamingFingerprint: fingerprint,
          projected,
        });
      } else {
        snapshotProjectionCache.set(session, {
          source: stored,
          length: stored.length,
          last: stored[stored.length - 1],
          // A full read is reusable only until the next full read or mutation.
          projectedFresh: false,
          streamingFingerprint: fingerprint,
          projected,
        });
      }
    } else {
      projected = projectWithEntryIds(raw);
    }
  }
  if (latestOnly && projected.length > 1) {
    const last = projected[projected.length - 1]!;
    const cached = latestOnlyProjectionCache.get(session);
    if (cached?.last === last) {
      projected = cached.projected;
    } else {
      projected = [last];
      latestOnlyProjectionCache.set(session, { last, projected });
    }
  }
  if (throughputByStartedAt)
    projected = applyThroughput(projected, throughputByStartedAt);
  if (toolPartialOutputByCallId && toolPartialOutputByCallId.size > 0) {
    projected = applyToolOutput(projected, toolPartialOutputByCallId);
  }
  if (toolStartedAt && toolStartedAt.size > 0 && toolEndedAt) {
    projected = applyToolTiming(projected, toolStartedAt, toolEndedAt);
  }
  if (accountContext) {
    projected = applyMessageAccountIds(projected, accountContext);
    projected = applyMessageAgentIds(projected, accountContext);
  }
  return projected;
}

/** 実行中 tool の累積 partial result を対応する UI パートへ注入する。 */
export function applyToolOutput(
  messages: UiMessage[],
  partialOutputByCallId: Map<string, string>,
): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" ||
        (message.parts.length <= 1 && message.parts[0]?.type !== "tool")) return message;
    let parts: UiMessage["parts"] | undefined;
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index]!;
      if (part.type !== "tool") continue;
      const output = partialOutputByCallId.get(part.callID);
      if (
        output === undefined ||
        (part.state.status !== "running" && part.state.status !== "pending")
      ) continue;
      if (!parts) parts = message.parts.slice();
      parts[index] = {
        ...part,
        state: {
          ...part.state,
          output,
          error: undefined,
        },
      };
    }
    return parts ? { ...message, parts } : message;
  });
}

/** toolCallId に対応する tool パートに実行開始/終了時刻を注入する。 */
export function applyToolTiming(
  messages: UiMessage[],
  toolStartedAt: Map<string, number>,
  toolEndedAt: Map<string, number>,
): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" ||
        (message.parts.length <= 1 && message.parts[0]?.type !== "tool")) return message;
    let parts: UiMessage["parts"] | undefined;
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index]!;
      if (part.type !== "tool") continue;
      const startedAtMs = toolStartedAt.get(part.callID);
      if (startedAtMs === undefined) continue;
      const endedAtMs = toolEndedAt.get(part.callID) ?? part.state.endedAtMs;
      // Timing is fixed once known; rebuilding the part on every 100ms snapshot
      // would recreate the whole tool history for no visible change.
      if (part.state.startedAtMs === startedAtMs && part.state.endedAtMs === endedAtMs) continue;
      if (!parts) parts = message.parts.slice();
      parts[index] = {
        ...part,
        state: {
          ...part.state,
          startedAtMs,
          endedAtMs,
        },
      };
    }
    return parts ? { ...message, parts } : message;
  });
}
