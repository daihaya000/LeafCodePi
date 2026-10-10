import {
  detailTimeoutError, isDetailTimeoutError, TASK_DETAIL_OFFLINE_TIMEOUT_MS, TASK_DETAIL_TIMEOUT_MS,
} from "@backend-core/task-detail.mjs";
import { getTaskDetail } from "../task-lifecycle";
import { restoreOriginalUiHistory } from "./original-ui-history";

// The budgets and the timeout contract live in backend core.
const DEFAULT_TIMEOUT_MS = TASK_DETAIL_TIMEOUT_MS;
const DEFAULT_OFFLINE_TIMEOUT_MS = TASK_DETAIL_OFFLINE_TIMEOUT_MS;

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
        reject(Object.assign(new Error(message), { status: 504, timeout: true }));
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
      ? getTaskDetail(id).then((detail) => restoreOriginalUiHistory(detail))
      : getTaskDetail(id, detailOptions).then((detail) => restoreOriginalUiHistory(detail, detailOptions.includeMessages !== false)),
    timeoutMs,
    "タスク詳細の取得がタイムアウトしました",
  ).catch((error) => {
    // The timeout flag rule lives in backend core.
    if (isDetailTimeoutError(error)) {
      return withTimeout(
        getTaskDetail(id, { ...detailOptions, offline: true }).then((detail) => restoreOriginalUiHistory(detail, detailOptions.includeMessages !== false)),
        offlineTimeoutMs,
        "オフラインのタスク詳細取得がタイムアウトしました",
      ).catch((offlineError) => {
        if (isDetailTimeoutError(offlineError)) {
          const failure = detailTimeoutError("final");
          throw Object.assign(new Error(failure.message), { status: failure.status, timeout: true });
        }
        throw offlineError;
      });
    }
    throw error;
  });
}
