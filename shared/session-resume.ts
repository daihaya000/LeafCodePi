export const RESUME_ENTRY_TYPE = "leafcode-session-resume";
const MAX_DELAY_SECONDS = 24 * 60 * 60;
const MAX_MESSAGE_CHARS = 4_000;

export type ResumeReservation = {
  version: 1;
  sessionId: string;
  id: string;
  createdAt: string;
  at: string;
  message: string;
  status: "scheduled" | "fired" | "cancelled" | "failed";
  error?: string;
};

/** Validate the persisted extension record; malformed latest records fail closed. */
export function parseResumeReservation(value: unknown, sessionId: string): ResumeReservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<ResumeReservation>;
  if (record.version !== 1 || record.sessionId !== sessionId || typeof record.id !== "string" || !record.id ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) ||
      typeof record.message !== "string" || !record.message.trim() || record.message.length > MAX_MESSAGE_CHARS ||
      !["scheduled", "fired", "cancelled", "failed"].includes(record.status ?? "")) return undefined;
  const duration = Date.parse(record.at) - Date.parse(record.createdAt);
  if (duration < 1_000 || duration > MAX_DELAY_SECONDS * 1_000) return undefined;
  return record as ResumeReservation;
}

/** Find the newest reservation on the active branch, never reviving an older record. */
export function resumeReservationFromBranch(
  branch: readonly unknown[],
  sessionId: string,
): ResumeReservation | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type === "custom" && record.customType === RESUME_ENTRY_TYPE) {
      return parseResumeReservation(record.data, sessionId);
    }
  }
  return undefined;
}
