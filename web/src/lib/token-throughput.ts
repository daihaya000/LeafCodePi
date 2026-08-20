/**
 * LLM generation throughput helpers.
 *
 * Industry decode tok/s (vLLM / genai-perf / Anyscale-style):
 *   (outputTokens - 1) / (lastTokenAt - firstTokenAt)
 * The first token is produced during TTFT, so the first→last window spans
 * N−1 inter-token intervals. Prefill / TTFT are excluded on purpose.
 *
 * End-to-end fallback (when first-token timing is unavailable):
 *   outputTokens / (completedAt - startedAt)
 */

export type ThroughputTiming = {
  /** Wall time when the assistant message / request started (ms). */
  startedAtMs: number;
  /** Wall time of the first streamed content delta (ms). */
  firstTokenAtMs: number | null;
  /** Wall time of the latest streamed content delta (ms). */
  lastTokenAtMs: number | null;
  /** Provider-reported output tokens (includes reasoning when reported). */
  outputTokens: number | null;
  /** Accumulated streamed character length for live estimates. */
  charCount: number;
};

export type ThroughputSnapshot = {
  outputTokens: number;
  /** Decode tok/s when measurable; otherwise end-to-end; null if unknown. */
  tokensPerSecond: number | null;
  /** True when tokensPerSecond is decode (excludes TTFT). */
  decodePhase: boolean;
};

const CONTENT_DELTA_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
]);

/** Rough live estimate when the provider has not yet reported usage.output. */
export function estimateTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.max(1, Math.round(charCount / 4));
}

export function isContentDeltaType(type: unknown): boolean {
  return typeof type === "string" && CONTENT_DELTA_TYPES.has(type);
}

export function createThroughputTiming(startedAtMs = Date.now()): ThroughputTiming {
  return {
    startedAtMs,
    firstTokenAtMs: null,
    lastTokenAtMs: null,
    outputTokens: null,
    charCount: 0,
  };
}

export function noteContentDelta(
  timing: ThroughputTiming,
  delta: string | undefined,
  atMs = Date.now(),
): ThroughputTiming {
  const next = { ...timing };
  if (next.firstTokenAtMs === null) next.firstTokenAtMs = atMs;
  next.lastTokenAtMs = atMs;
  if (typeof delta === "string" && delta.length > 0) {
    next.charCount += delta.length;
  }
  return next;
}

export function noteReportedOutputTokens(
  timing: ThroughputTiming,
  outputTokens: number | null | undefined,
): ThroughputTiming {
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) {
    return timing;
  }
  return { ...timing, outputTokens: Math.round(outputTokens) };
}

/**
 * Decode-phase tokens/sec: (N − 1) / (T_last − T_first).
 * Returns null when N < 2 or the decode window is missing / non-positive.
 */
export function decodeTokensPerSecond(
  outputTokens: number,
  firstTokenAtMs: number,
  lastTokenAtMs: number,
): number | null {
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 2 ||
    !Number.isFinite(firstTokenAtMs) ||
    !Number.isFinite(lastTokenAtMs)
  ) {
    return null;
  }
  const seconds = (lastTokenAtMs - firstTokenAtMs) / 1000;
  if (!(seconds > 0)) return null;
  const rate = (outputTokens - 1) / seconds;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * End-to-end tokens/sec including TTFT: N / (T_end − T_start).
 */
export function endToEndTokensPerSecond(
  outputTokens: number,
  startedAtMs: number,
  completedAtMs: number,
): number | null {
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 1 ||
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(completedAtMs)
  ) {
    return null;
  }
  const seconds = (completedAtMs - startedAtMs) / 1000;
  if (!(seconds > 0)) return null;
  const rate = outputTokens / seconds;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function resolveOutputTokens(timing: ThroughputTiming): number {
  if (typeof timing.outputTokens === "number" && timing.outputTokens > 0) {
    return timing.outputTokens;
  }
  return estimateTokensFromChars(timing.charCount);
}

/**
 * Prefer decode tok/s; fall back to end-to-end when first-token timing is absent.
 */
export function snapshotThroughput(
  timing: ThroughputTiming,
  nowMs = Date.now(),
): ThroughputSnapshot | null {
  const outputTokens = resolveOutputTokens(timing);
  if (outputTokens < 1) return null;

  const last = timing.lastTokenAtMs ?? nowMs;
  if (timing.firstTokenAtMs !== null) {
    const decode = decodeTokensPerSecond(outputTokens, timing.firstTokenAtMs, last);
    if (decode !== null) {
      return { outputTokens, tokensPerSecond: decode, decodePhase: true };
    }
  }

  const e2e = endToEndTokensPerSecond(outputTokens, timing.startedAtMs, last);
  if (e2e === null) return null;
  return { outputTokens, tokensPerSecond: e2e, decodePhase: false };
}

/** Compact display label, e.g. `42 tok/s`, `1.2k tok/s`. */
export function formatTokensPerSecond(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "";
  if (rate < 10) return `${rate.toFixed(1)} tok/s`;
  if (rate < 1000) return `${Math.round(rate)} tok/s`;
  if (rate < 10_000) return `${(rate / 1000).toFixed(1).replace(/\.0$/, "")}k tok/s`;
  if (rate < 1_000_000) return `${Math.round(rate / 1000)}k tok/s`;
  return `${(rate / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tok/s`;
}
