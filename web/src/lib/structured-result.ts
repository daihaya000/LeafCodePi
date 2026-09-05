export type StructuredResultStatus =
  | "progress"
  | "completed"
  | "verified_completed"
  | "blocked";

export type StructuredResult = {
  status: StructuredResultStatus;
  summary: string;
  next?: string;
  evidence?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

export function parseStructuredResult(text: string): StructuredResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].at(-1)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  try {
    const value: unknown = JSON.parse(candidate);
    if (!isRecord(value)) return null;
    const status = value.status;
    if (
      status !== "progress" &&
      status !== "completed" &&
      status !== "verified_completed" &&
      status !== "blocked"
    ) {
      return null;
    }
    const summary = asOptionalText(value.summary);
    if (!summary) return null;
    const next = asOptionalText(value.next);
    const evidence = asOptionalText(value.evidence);
    return {
      status,
      summary,
      ...(next ? { next } : {}),
      ...(evidence ? { evidence } : {}),
    };
  } catch {
    return null;
  }
}
