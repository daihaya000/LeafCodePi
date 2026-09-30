export const REPLACE_TASK_NOT_FOUND_MESSAGE: string;

export function attachReplacementSession<Live>(deps: {
  /** Persists the new identity; a falsy result means the task no longer exists. */
  persistIdentity?: () => unknown;
  attach: () => Promise<Live>;
  disposeSession: () => void;
  /** Restores the previous persisted identity after a failed attach. */
  restoreIdentity?: () => void;
}): Promise<Live>;
