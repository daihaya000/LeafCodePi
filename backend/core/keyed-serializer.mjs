/**
 * Serialize work that must not overlap for the same key (a promotion target
 * directory), while still allowing different keys to run concurrently.
 *
 * The queue is a promise chain: the caller links its own release promise into the
 * map and waits for the previous holder. The release promise is created but never
 * rejected, so a failing action cannot break the chain for later callers.
 */
export function runSerializedByKey(inflight, key, action) {
  const previous = inflight.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  inflight.set(key, current);
  return (async () => {
    await previous;
    try {
      return await action();
    } finally {
      release();
      // Only the holder that is still recorded clears the entry.
      if (inflight.get(key) === current) inflight.delete(key);
    }
  })();
}
