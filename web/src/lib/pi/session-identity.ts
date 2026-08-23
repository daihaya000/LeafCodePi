import type { TaskSummary } from "@/lib/types";

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
): SessionIdentityPatch {
  const patch: SessionIdentityPatch = {};
  if (identity.sessionId != null && identity.sessionId !== task.sessionId) {
    patch.sessionId = identity.sessionId;
  }
  if (identity.sessionFile != null && identity.sessionFile !== task.sessionFile) {
    patch.sessionFile = identity.sessionFile;
  }
  if (identity.providerID !== undefined && identity.providerID !== task.providerID) {
    patch.providerID = identity.providerID;
  }
  if (identity.modelID !== undefined && identity.modelID !== task.modelID) {
    patch.modelID = identity.modelID;
  }
  return patch;
}
