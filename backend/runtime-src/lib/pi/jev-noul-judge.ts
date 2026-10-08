import { evaluateTypeSafe, type TypeSafeResponse } from "@/lib/pi/typesafe-system-one";

/**
 * Yes/no Jev judge for standalone extensions such as the ToDo gate. They cannot
 * import the WebUI's Jev client, so the harness publishes this judge on
 * globalThis. An inactive Jev answers null and callers keep their conventional
 * behavior. Credentials stay server-side: only probabilities cross over.
 *
 * Must match extensions/leafcode-todowrite/jev-bridge.ts
 */
export const JEV_NOUL_JUDGE_KEY = "__leafcodeJevNoulJudge" as const;

export type JevNoulQuestion = {
  instructions: string;
  criteria?: { true: string; false: string };
};

export type JevNoulRequest = {
  state: Record<string, unknown>;
  questions: Record<string, JevNoulQuestion>;
  signal?: AbortSignal;
};

/**
 * Probability of yes (0..1) for every question id, or null when Jev is
 * unavailable or could not answer all of them.
 */
export type JevNoulJudge = (request: JevNoulRequest) => Promise<Record<string, number> | null>;

type Evaluate = (
  request: Parameters<typeof evaluateTypeSafe>[0],
  options: { signal?: AbortSignal },
) => Promise<TypeSafeResponse>;

export function registerJevNoulJudge(next: JevNoulJudge | null): void {
  (globalThis as typeof globalThis & { [JEV_NOUL_JUDGE_KEY]?: JevNoulJudge | null })[JEV_NOUL_JUDGE_KEY] = next;
}

/**
 * Never throws: an unusable Jev, a failed request and an incomplete or malformed
 * answer are all null. The questions go out as one request, so asking several
 * costs no extra round trip.
 */
export function createJevNoulJudge(deps: {
  /** False when no Jev model can be called, so the request is skipped entirely. */
  isUsable: () => Promise<boolean>;
  evaluate?: Evaluate;
}): JevNoulJudge {
  const evaluate = deps.evaluate ?? evaluateTypeSafe;
  return async ({ state, questions, signal }) => {
    try {
      const entries = Object.entries(questions);
      if (entries.length === 0 || signal?.aborted || !(await deps.isUsable()) || signal?.aborted) return null;
      const response = await evaluate({
        state,
        questions: Object.fromEntries(entries.map(([id, { instructions, criteria }]) => [
          id,
          { type: "noul" as const, instructions, ...(criteria ? { criteria } : {}) },
        ])),
      }, { signal });
      const probabilities: Record<string, number> = {};
      for (const [id] of entries) {
        const answer = response.answers[id];
        if (answer?.type !== "noul" || typeof answer.noul !== "number") return null;
        probabilities[id] = answer.noul;
      }
      return probabilities;
    } catch {
      return null;
    }
  };
}
