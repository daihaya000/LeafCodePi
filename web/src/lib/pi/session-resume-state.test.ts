import { describe, expect, it } from "vitest";
import { RESUME_ENTRY_TYPE, resumeReservationFromBranch } from "@shared/session-resume";

const sessionId = "session-1";
const reservation = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  sessionId,
  id: "resume-1",
  createdAt: "2026-10-08T10:00:00.000Z",
  at: "2026-10-08T10:01:00.000Z",
  message: "結果を確認する",
  status: "scheduled",
  ...overrides,
});
const entry = (data: unknown) => ({ type: "custom", customType: RESUME_ENTRY_TYPE, data });

describe("resumeReservationFromBranch", () => {
  it("returns the latest scheduled reservation for the owning session", () => {
    const result = resumeReservationFromBranch([
      entry(reservation()),
      { type: "message", id: "message-1" },
      entry(reservation({ id: "resume-2", message: "新しい確認" })),
    ], sessionId);
    expect(result?.id).toBe("resume-2");
    expect(result?.message).toBe("新しい確認");
  });

  it("does not revive an earlier reservation after a terminal or malformed latest entry", () => {
    expect(resumeReservationFromBranch([
      entry(reservation()),
      entry(reservation({ status: "cancelled" })),
    ], sessionId)?.status).toBe("cancelled");
    expect(resumeReservationFromBranch([
      entry(reservation()),
      entry({ version: 1, status: "scheduled" }),
    ], sessionId)).toBeUndefined();
  });

  it("rejects records belonging to another session", () => {
    expect(resumeReservationFromBranch([entry(reservation({ sessionId: "forked-session" }))], sessionId)).toBeUndefined();
  });
});
