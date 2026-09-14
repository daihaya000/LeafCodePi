import { getTaskDetail } from "@/lib/pi/harness";

const DEFAULT_TIMEOUT_MS = 30_000;

type DetailOptions = NonNullable<Parameters<typeof getTaskDetail>[1]>;

/**
 * Bound ensureLive hangs for HTTP reads that can degrade to offline transcript.
 * After `timeoutMs`, falls back to `getTaskDetail(..., { offline: true })`.
 */
export function getTaskDetailBounded(
  id: string,
  options?: DetailOptions & { timeoutMs?: number },
): Promise<Awaited<ReturnType<typeof getTaskDetail>>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...detailOptions } = options ?? {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    getTaskDetail(id, detailOptions),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error("タスク詳細の取得がタイムアウトしました"), {
            status: 504,
            timeout: true,
          }),
        );
      }, timeoutMs);
      timer.unref?.();
    }),
  ])
    .catch((error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "timeout" in error &&
        (error as { timeout?: boolean }).timeout === true
      ) {
        return getTaskDetail(id, { ...detailOptions, offline: true });
      }
      throw error;
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}
