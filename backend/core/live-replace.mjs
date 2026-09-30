export const REPLACE_TASK_NOT_FOUND_MESSAGE = "タスクが見つかりません";

/**
 * Shared tail of every live-session replacement (account route, persona, Bot
 * SOUL). The replacement session is already created by the caller; this owns
 * only the ordering that keeps ownership safe:
 *
 *  - persist the new identity first (when the replacement changes one); if the
 *    task vanished, dispose the unattached session and report 404
 *  - attach; on failure dispose the unattached session BEFORE restoring the
 *    previous persisted identity, then rethrow the attach error
 *
 * Nothing is disposed after a successful attach: the new live owns the session.
 */
export async function attachReplacementSession(deps) {
  if (deps.persistIdentity) {
    const updated = deps.persistIdentity();
    if (!updated) {
      deps.disposeSession();
      throw Object.assign(new Error(REPLACE_TASK_NOT_FOUND_MESSAGE), { status: 404 });
    }
  }
  try {
    return await deps.attach();
  } catch (error) {
    deps.disposeSession();
    // A failed restore surfaces instead of the attach error, as before.
    deps.restoreIdentity?.();
    throw error;
  }
}
