import {
  entryIdsForProjectedMessages,
  isGoalLoopTurnMarker,
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
  projectedFresh: boolean;
  projected: UiMessage[];
};

type BranchProjectionCache = {
  leafId: string | null;
  raw: unknown[];
  entryIdByMessage: Map<unknown, string>;
  projectedFresh: boolean;
  projected: UiMessage[];
};

/** Stable session history is reused between 100ms SSE snapshots. */
const snapshotProjectionCache = new WeakMap<object, SnapshotProjectionCache>();
/** Full current-branch history survives compaction and is reused between snapshots. */
const branchProjectionCache = new WeakMap<object, BranchProjectionCache>();

function isPlainUserMessage(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    Object.prototype.hasOwnProperty.call(item, "role") &&
    (item as { role?: unknown }).role === "user"
  );
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

/** throughput timing をメッセージへ反映（tok/s + 実測の応答所要時間）。 */
export function applyThroughput(
  messages: UiMessage[],
  throughputByStartedAt: Map<number, ThroughputTiming>,
): UiMessage[] {
  if (throughputByStartedAt.size === 0) return messages;
  const nowMs = Date.now();
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const timing = throughputByStartedAt.get(message.createdAt);
    if (!timing) return message;
    // 応答全体の所要時間（思考＋生成、TTFT 込み）。Pi の assistant timestamp は
    // 生成「開始」時刻のため、直前レコードとの差分では常に 0s になる —
    // 実測 lastToken を使う（応答完了後は永続化された値で復元）。
    const responseDurationMs = Math.max(
      0,
      (timing.lastTokenAtMs ?? nowMs) - timing.startedAtMs,
    );
    const snap = snapshotThroughput(timing, nowMs);
    if (!snap || snap.tokensPerSecond === null) {
      return responseDurationMs > 0
        ? { ...message, responseDurationMs }
        : message;
    }
    return {
      ...message,
      outputTokens: snap.outputTokens,
      tokensPerSecond: snap.tokensPerSecond,
      tokensPerSecondDecode: snap.decodePhase,
      ...(responseDurationMs > 0 ? { responseDurationMs } : {}),
    };
  });
}

export type MessageAccountContext = {
  /** 現在のセッションアカウント（null = 既定）。 */
  accountId: string | null;
  /** 一度記録したメッセージのアカウント。セッション置き換え後も過去の値を保持する。 */
  byMessageId: Map<string, string>;
};

/** アシスタントメッセージへ生成時のアカウントを記録する（初回のみ記録、以降は保持）。 */
export function applyMessageAccountIds(
  messages: UiMessage[],
  context: MessageAccountContext,
): UiMessage[] {
  const { accountId, byMessageId } = context;
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let recorded = byMessageId.get(message.id);
    if (recorded === undefined && accountId) {
      recorded = accountId;
      byMessageId.set(message.id, recorded);
    }
    if (!recorded || message.accountId === recorded) return message;
    changed = true;
    return { ...message, accountId: recorded };
  });
  return changed ? result : messages;
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
      historyRaw = branch.flatMap((entry) => {
        if (entry.type === "message") {
          entryIdByMessage.set(entry.message, entry.id);
          return [entry.message];
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
          if (!piRawMessageProjectsToUi(message) && !isGoalLoopTurnMarker(message)) return [];
          entryIdByMessage.set(message, entry.id);
          return [message];
        }
        if (entry.type !== "compaction") return [];
        const timestamp = Date.parse(entry.timestamp);
        return [
          {
            id: entry.id,
            role: "compactionSummary" as const,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
          },
        ];
      });
    }
  }
  const streaming = session.agent.state.streamingMessage;
  const streamingInHistory = useBranchHistory
    ? entryIdByMessage.has(streaming)
    : stored.includes(streaming);
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
    let result = projectPiMessages(raw, indexOffset);
    // Pi のメッセージ本体には id が無いため、projectPiMessages は `msg-N` を仮 id
    // にする。「入力欄に戻す」はエントリ id 必須なので、参照一致するエントリの id で上書き
    const entryIds = entryIdsForProjectedMessages(raw, entryIdByMessage);
    result = result.map((message, index) => {
      const entryId = entryIds[index];
      return entryId ? { ...message, id: entryId } : message;
    });
    return result;
  };

  const projectLatestWithEntryIds = (raw: unknown[]): UiMessage[] => {
    const latestIndex = raw.findLastIndex(piRawMessageProjectsToUi);
    if (latestIndex < 0) return [];
    const markerIndex = latestGoalLoopMarkerIndex(raw, latestIndex);
    const startIndex = markerIndex >= 0 ? markerIndex : latestIndex;
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
          projected,
        });
      }
    }
    if (canAppendStreaming) {
      const markerIndex = latestGoalLoopMarkerIndex(historyRaw);
      const streamingProjection = projectPiMessages(
        markerIndex >= 0 ? [historyRaw[markerIndex], streaming] : [streaming],
        markerIndex >= 0 ? Math.max(0, historyRaw.length - 1) : historyRaw.length,
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
    projected = projectLatestWithEntryIds(historyRaw);
    if (useBranchHistory) {
      branchProjectionCache.set(session, {
        leafId: branchLeafId,
        raw: historyRaw,
        entryIdByMessage,
        projectedFresh: false,
        projected: cachedBranch?.projected ?? [],
      });
    } else {
      const cached = snapshotProjectionCache.get(session);
      snapshotProjectionCache.set(session, {
        source: stored,
        length: stored.length,
        last: stored[stored.length - 1],
        projectedFresh: false,
        projected: cached?.projected ?? [],
      });
    }
  } else {
    const raw = streamingInHistory ? historyRaw : [...historyRaw, streaming];
    projected = projectWithEntryIds(raw);
    if (streamingInHistory) {
      if (useBranchHistory) {
        branchProjectionCache.set(session, {
          leafId: branchLeafId,
          raw: historyRaw,
          entryIdByMessage,
          projectedFresh: true,
          projected,
        });
      } else {
        snapshotProjectionCache.set(session, {
          source: stored,
          length: stored.length,
          last: stored[stored.length - 1],
          projectedFresh: true,
          projected,
        });
      }
    }
  }
  if (latestOnly && projected.length > 1) {
    projected = [projected[projected.length - 1]!];
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
  }
  return projected;
}

/** 実行中 tool の累積 partial result を対応する UI パートへ注入する。 */
export function applyToolOutput(
  messages: UiMessage[],
  partialOutputByCallId: Map<string, string>,
): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      const output = partialOutputByCallId.get(part.callID);
      if (
        output === undefined ||
        (part.state.status !== "running" && part.state.status !== "pending")
      ) {
        return part;
      }
      changed = true;
      return {
        ...part,
        state: {
          ...part.state,
          output,
          error: undefined,
        },
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

/** toolCallId に対応する tool パートに実行開始/終了時刻を注入する。 */
export function applyToolTiming(
  messages: UiMessage[],
  toolStartedAt: Map<string, number>,
  toolEndedAt: Map<string, number>,
): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      const startedAtMs = toolStartedAt.get(part.callID);
      if (startedAtMs === undefined) return part;
      changed = true;
      return {
        ...part,
        state: {
          ...part.state,
          startedAtMs,
          endedAtMs: toolEndedAt.get(part.callID) ?? part.state.endedAtMs,
        },
      };
    });
    return changed ? { ...message, parts } : message;
  });
}
