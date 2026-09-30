/**
 * Session metadata a running session reports back onto its persisted task. Only
 * values that actually differ are returned, so a streaming event that repeats the
 * same identity writes nothing.
 *
 * A missing runtime value never erases a persisted one: `sessionId`/`sessionFile`
 * must be non-null to win, and the model pair must be present (a runtime without a
 * model cannot clear the stored model).
 */
export function sessionIdentityPatch(task, identity) {
  const patch = {};
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
