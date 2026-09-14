import { getTaskDetail } from "@/lib/pi/harness";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OFFLINE_TIMEOUT_MS = 10_000;

type DetailOptions = NonNullable<Parameters<typeof getTaskDetail>[1]>;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error(message), {
            status: 504,
            timeout: true,
          }),
        );
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Bound ensureLive hangs for HTTP reads that can degrade to offline transcript.
 * After `timeoutMs`, falls back to `getTaskDetail(..., { offline: true })`
 * which itself is bounded by `offlineTimeoutMs`.
 */
export function getTaskDetailBounded(
  id: string,
  options?: DetailOptions & { timeoutMs?: number; offlineTimeoutMs?: number },
): Promise<Awaited<ReturnType<typeof getTaskDetail>>> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    offlineTimeoutMs = DEFAULT_OFFLINE_TIMEOUT_MS,
    ...detailOptions
  } = options ?? {};

  return withTimeout(
    Object.keys(detailOptions).length === 0
      ? getTaskDetail(id)
      : getTaskDetail(id, detailOptions),
    timeoutMs,
    "タスク詳細の取得がタイムアウトしました",
  ).catch((error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "timeout" in error &&
      (error as { timeout?: boolean }).timeout === true
    ) {
      return withTimeout(
        getTaskDetail(id, { ...detailOptions, offline: true }),
        offlineTimeoutMs,
        "オフラインのタスク詳細取得がタイムアウトしました",
      ).catch((offlineError) => {
        if (
          typeof offlineError === "object" &&
          offlineError !== null &&
          "timeout" in offlineError &&
          (offlineError as { timeout?: boolean }).timeout === true
        ) {
          throw Object.assign(
            new Error("タスク詳細を取得できませんでした"),
            { status: 503, timeout: true },
          );
        }
        throw offlineError;
      });
    }
    throw error;
  });
}
