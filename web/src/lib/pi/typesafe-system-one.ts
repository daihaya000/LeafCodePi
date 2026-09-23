import { recordTypesafeUsage } from "@/lib/codexbar/providers/typesafe";
import { readJevModelSettings, resolveJevModelConnection } from "./jev-model-config";

type TypeSafeQuestion = {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string | null> | readonly string[];
};

type TypeSafeRequest = {
  state: string | object | readonly unknown[];
  questions: Record<string, TypeSafeQuestion>;
};

export type TypeSafeAnswer = {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
};

export type TypeSafeResponse = {
  model: string;
  answers: Record<string, TypeSafeAnswer | undefined>;
  usage: { input_tokens: number; output_tokens: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inRange(value: unknown, max = 1): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

/** Validate at the shared boundary: malformed judgments must also abort compaction. */
function validateResponse(result: unknown, request: TypeSafeRequest): asserts result is TypeSafeResponse {
  if (!isRecord(result) || typeof result.model !== "string" || !result.model || !isRecord(result.answers) || !isRecord(result.usage)) {
    throw new Error("Jev API returned an invalid response");
  }
  for (const key of ["input_tokens", "output_tokens"]) {
    const count = result.usage[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("Jev API returned invalid usage");
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) throw new Error("Jev API returned a missing or mismatched answer");
    if (question.type === "noul") {
      if (!inRange(answer.noul)) throw new Error("Jev API returned an invalid noul");
    } else {
      if (!inRange(answer.confidence)) throw new Error("Jev API returned invalid confidence");
      if (question.type === "choice") {
        if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria ?? {}, answer.choice)) {
          throw new Error("Jev API returned an unknown choice");
        }
      } else if (!Array.isArray(question.criteria) || !inRange(answer.score, question.criteria.length - 1)) {
        throw new Error("Jev API returned an invalid score");
      }
    }
  }
}

/** All LCP judgments share the selected System One endpoint; never fall back to another provider. */
export async function evaluateTypeSafe(
  request: TypeSafeRequest,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<TypeSafeResponse> {
  const settings = readJevModelSettings();
  const { baseUrl, model, apiKey: storedKey, headers } = await resolveJevModelConnection(settings);
  const apiKey = options.apiKey ?? storedKey;
  const response = await (options.fetchImpl ?? fetch)(
    `${baseUrl}/systemone`,
    {
      method: "POST",
      headers: {
        ...headers,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      redirect: "error",
      body: JSON.stringify({ ...request, model }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(settings.timeoutMs)])
        : AbortSignal.timeout(settings.timeoutMs),
    },
  );
  if (!response.ok) throw new Error(`Jev API error: ${response.status}`);
  const result: unknown = await response.json();
  validateResponse(result, request);
  if (settings.provider === "typesafe") recordTypesafeUsage(result.usage);
  return result;
}
