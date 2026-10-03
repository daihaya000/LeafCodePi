export type BackendRestartStatus = {
  backend?: {
    ready?: boolean;
    startedAt?: string | null;
    generation?: { matches?: boolean };
  } | null;
};

/** A ready old process is not evidence that the requested restart succeeded. */
export function createBackendRestartCheck(previous: BackendRestartStatus | null) {
  const previousStart = previous?.backend?.startedAt;
  let sawUnavailable = previous?.backend?.ready === false;
  return (current: BackendRestartStatus): boolean => {
    const backend = current.backend;
    if (backend?.ready !== true) {
      sawUnavailable = true;
      return false;
    }
    if (!backend.startedAt || backend.generation?.matches === false) return false;
    return previousStart ? backend.startedAt !== previousStart : sawUnavailable;
  };
}
