/**
 * Runs `action` exclusively for `key`: a second call for the same key waits for the
 * first to finish, while other keys proceed independently. The in-flight map is
 * owned by the caller.
 */
export function runSerializedByKey<T>(
  inflight: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T>;
