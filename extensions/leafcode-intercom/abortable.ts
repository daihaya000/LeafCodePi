/** Stop one caller's wait without cancelling a shared connection attempt. */
export function waitWithAbort<T>(operation: () => Promise<T>, signal?: AbortSignal, onAbort?: () => void, abortMessage = "Cancelled"): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new Error(abortMessage));
      onAbort?.();
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      operation().then((value) => {
        cleanup();
        resolve(value);
      }, (error) => {
        cleanup();
        reject(error);
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
