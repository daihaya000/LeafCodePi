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

/**
 * The identity a running session is allowed to report: with a preserved task model
 * only the transcript location is projected; otherwise the model pair is included
 * too (and the patch rule above keeps a model-less runtime from erasing it).
 */
export function sessionIdentitySource({ preserveTaskModel, sessionId, sessionFile, providerID, modelID }) {
  const transcript = { sessionId, sessionFile };
  return preserveTaskModel === true ? transcript : { providerID, modelID, ...transcript };
}

/** True when the patch would actually write something. */
export function hasIdentityChanges(patch) {
  return Object.keys(patch).length > 0;
}
