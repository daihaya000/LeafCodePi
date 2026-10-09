import type { TypeSafeAnswer, TypeSafeRequest } from "./typesafe-system-one";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("OpenAI Decisions API returned an invalid judgment");
}

/** Keep the existing Jev interface; only the HTTP boundary speaks Decisions. */
export function toDecisionsRequest(request: TypeSafeRequest, model: string) {
  return {
    model,
    input: typeof request.state === "string" ? request.state : JSON.stringify(request.state),
    questions: Object.entries(request.questions).map(([name, question]) => {
      const { instructions, criteria } = question;
      if (question.type === "noul") {
        if (criteria !== undefined && !record(criteria)) throw new Error("Jev predicate criteria must be an object");
        const definitions = ["true", "false"].flatMap((key) => {
          const description = (criteria as Record<string, string | null> | undefined)?.[key];
          return description == null ? [] : [`${key}: ${description}`];
        });
        return {
          type: "predicate" as const, name,
          instructions: definitions.length ? `${instructions}\n\nCriteria:\n${definitions.join("\n")}` : instructions,
        };
      }
      if (question.type === "choice") {
        if (!record(criteria) || Object.keys(criteria).length < 2) throw new Error("Jev choice needs at least two options");
        return {
          type: "choice" as const, name, instructions,
          choices: Object.entries(criteria).map(([value, description]) => ({ value, description: description ?? value })),
        };
      }
      if (!Array.isArray(criteria) || criteria.length < 2) throw new Error("Jev score needs at least two levels");
      return {
        type: "score" as const, name, instructions,
        levels: criteria.map((description, index) => ({ label: String(index), description })),
      };
    }),
  };
}

function probabilities(value: unknown, keys: readonly string[], score: boolean): Record<string, number> {
  if (!Array.isArray(value) || value.length !== keys.length) invalid();
  const entries: Array<[string, number]> = [];
  for (const item of value) {
    if (!record(item) || typeof item.probability !== "number" || !Number.isFinite(item.probability) ||
      item.probability < 0 || item.probability > 1) invalid();
    if (score ? !Number.isInteger(item.value) : typeof item.value !== "string") invalid();
    const key = String(item.value);
    if (!keys.includes(key)) invalid();
    entries.push([key, item.probability]);
  }
  if (new Set(entries.map(([key]) => key)).size !== keys.length ||
    Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > 0.001) invalid();
  return Object.fromEntries(entries);
}

/** Refusals and missing/mismatched answers are failures, never synthesized judgments. */
export function fromDecisionsResponse(value: unknown, request: TypeSafeRequest): unknown {
  if (!record(value) || !Array.isArray(value.answers) || value.answers.length !== Object.keys(request.questions).length) invalid();
  const entries: Array<[string, TypeSafeAnswer]> = [];
  const seen = new Set<string>();
  for (const raw of value.answers) {
    if (!record(raw) || typeof raw.name !== "string" || !Object.hasOwn(request.questions, raw.name) || seen.has(raw.name)) invalid();
    seen.add(raw.name);
    const question = request.questions[raw.name];
    if (raw.type === "refusal") throw new Error("OpenAI Decisions API refused a judgment");
    if (raw.type !== (question.type === "noul" ? "predicate" : question.type)) invalid();
    // Scalar ranges, confidence, model and usage are checked by the shared Jev validator.
    if (question.type === "noul") {
      entries.push([raw.name, { type: "noul", noul: raw.probability as number }]);
    } else if (question.type === "choice") {
      entries.push([raw.name, {
        type: "choice", choice: raw.choice as string, confidence: raw.confidence as number,
        probabilities: probabilities(raw.probabilities, Object.keys(question.criteria ?? {}), false),
      }]);
    } else {
      const levels = question.criteria as readonly string[];
      const legend = Object.fromEntries(levels.map((description, index) => [String(index), description]));
      entries.push([raw.name, {
        type: "score", score: raw.score as number, confidence: raw.confidence as number, legend,
        probabilities: probabilities(raw.probabilities, Object.keys(legend), true),
      }]);
    }
  }
  return { model: value.model, answers: Object.fromEntries(entries), usage: value.usage };
}
