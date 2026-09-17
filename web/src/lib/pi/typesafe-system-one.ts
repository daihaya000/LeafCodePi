import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { recordTypesafeUsage } from "@/lib/codexbar/providers/typesafe";
import {
  registerTypeSafeProvider,
  TYPESAFE_API_BASE_URL,
  TYPESAFE_PROVIDER_ID,
} from "./typesafe-provider";

const TYPESAFE_TIMEOUT_MS = 2_000;

type TypeSafeQuestion = {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string | null> | readonly string[];
};

type TypeSafeRequest = {
  state: string | object | readonly unknown[];
  model: "jev-latest";
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

async function storedTypeSafeApiKey(): Promise<string> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  registerTypeSafeProvider(runtime);
  const apiKey = (await runtime.getAuth(TYPESAFE_PROVIDER_ID))?.auth.apiKey?.trim();
  if (!apiKey) throw new Error("TypeSafe APIキーが設定されていません");
  return apiKey;
}

/** Server-side System One request. Credentials stay in Pi's auth storage. */
export async function evaluateTypeSafe(
  request: TypeSafeRequest,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<TypeSafeResponse> {
  const apiKey = options.apiKey ?? await storedTypeSafeApiKey();
  const response = await (options.fetchImpl ?? fetch)(
    `${TYPESAFE_API_BASE_URL}/systemone`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(TYPESAFE_TIMEOUT_MS)])
        : AbortSignal.timeout(TYPESAFE_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`TypeSafe API error: ${response.status}`);
  const result = (await response.json()) as TypeSafeResponse;
  recordTypesafeUsage(result.usage);
  return result;
}
