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

/**
 * Which parts of a session's identity may be projected onto the task. A preserved
 * task model (Auto-fallback or an agent/soul re-attach) means the stored
 * provider/model stay authoritative, so only the transcript location is reported.
 */
export function sessionIdentitySource(input: {
  preserveTaskModel?: boolean;
  sessionId?: string | null;
  sessionFile?: string | null;
  providerID?: string;
  modelID?: string;
}): SessionIdentity;

/** True when the patch would actually write something. */
export function hasIdentityChanges<
  T extends { sessionId?: unknown; sessionFile?: unknown; providerID?: unknown; modelID?: unknown },
>(patch: T): boolean;
