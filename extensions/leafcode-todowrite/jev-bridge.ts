/**
 * Optional Jev access offered by the LeafCodePi WebUI host.
 *
 * An extension cannot import the WebUI's Jev client, so the host publishes a
 * yes/no judge on globalThis (the same pattern as the permission and question
 * bridges). A standalone Pi install never publishes one. Callers must treat
 * `null` as "Jev is inactive" and keep their conventional behavior.
 *
 * Keep the key and the shapes in sync with web/src/lib/pi/jev-noul-judge.ts.
 */

export const JEV_NOUL_JUDGE_KEY = "__leafcodeJevNoulJudge" as const;

export type JevNoulQuestion = {
  /** A yes/no question phrased so that a high probability means yes. */
  instructions: string;
  criteria?: { true: string; false: string };
};

export type JevNoulRequest = {
  /** Data to judge. Jev reads it as data, never as instructions. */
  state: Record<string, unknown>;
  /** Independent questions over the same state, answered together in one request. */
  questions: Record<string, JevNoulQuestion>;
  signal?: AbortSignal;
};

/**
 * Probability of yes (0..1) for every question id, or null when Jev is
 * unavailable or could not answer all of them.
 */
export type JevNoulJudge = (request: JevNoulRequest) => Promise<Record<string, number> | null>;

type BridgeHost = typeof globalThis & { [JEV_NOUL_JUDGE_KEY]?: JevNoulJudge | null };

function readJudge(): JevNoulJudge | null {
  const judge = (globalThis as BridgeHost)[JEV_NOUL_JUDGE_KEY];
  return typeof judge === "function" ? judge : null;
}

/** True when a host published a judge. Whether Jev is usable is only known when asking. */
export function hasJevNoulJudge(): boolean {
  return readJudge() !== null;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** All-or-nothing: one missing or malformed probability discards the whole answer. */
function readProbabilities(answer: unknown, ids: readonly string[]): Record<string, number> | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const record = answer as Record<string, unknown>;
  const probabilities: Record<string, number> = {};
  for (const id of ids) {
    const value = Object.hasOwn(record, id) ? record[id] : undefined;
    if (!isProbability(value)) return null;
    probabilities[id] = value;
  }
  return probabilities;
}

/** Rejects when `signal` aborts, even if the host's judge ignores the signal. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // Always subscribe, so a late rejection of `work` is never left unhandled.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Ask Jev yes/no questions in one request. Never throws and never waits past
 * `timeoutMs`: no host, an inactive Jev, a failure, a timeout, an abort, and a
 * malformed or incomplete answer all return null.
 */
export async function requestJevNoul(
  request: Omit<JevNoulRequest, "signal">,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, number> | null> {
  const judge = readJudge();
  const ids = Object.keys(request.questions);
  if (!judge || ids.length === 0 || options.signal?.aborted) return null;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Jev judge timed out")), options.timeoutMs);
  try {
    const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
    const answer = await untilAborted(Promise.resolve(judge({ ...request, signal })), signal);
    return readProbabilities(answer, ids);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
