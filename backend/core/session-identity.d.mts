import type { TaskSummary } from "@shared/types";

export type SessionIdentity = {
  sessionId?: string | null;
  sessionFile?: string | null;
  providerID?: string;
  modelID?: string;
};

export type SessionIdentityPatch = Partial<
  Pick<TaskSummary, "sessionId" | "sessionFile" | "providerID" | "modelID">
>;

/** Return only session metadata that is newer than the persisted task record. */
export function sessionIdentityPatch(
  task: Pick<TaskSummary, "sessionId" | "sessionFile" | "providerID" | "modelID">,
  identity: SessionIdentity,
): SessionIdentityPatch;
