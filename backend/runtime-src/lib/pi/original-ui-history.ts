import { statSync } from "node:fs";
import { MAX_SESSION_LOAD_BYTES } from "@backend-core/session-memory-guard.mjs";
import { stripImageDataFromMessages } from "@shared/task-history-content.mjs";
import { readSessionHistoryPage } from "../session-history-page";
import { markColdMessageWindow } from "../task-history";
import type { TaskDetail } from "../types";
import { readHistoryPageSize } from "./history-page-size";

/** A model's memory-only projection is never the source of persisted UI history. */
export async function restoreOriginalUiHistory(detail: TaskDetail, includeMessages = true): Promise<TaskDetail> {
  if (!detail.sessionFile) return detail;
  try {
    if (statSync(detail.sessionFile).size <= MAX_SESSION_LOAD_BYTES) return detail;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return detail;
    throw error;
  }
  const revision = (detail as TaskDetail & { messageRevision?: string }).messageRevision;
  const originalDetail = { ...detail, ...(typeof revision === "string" ? { messageRevision: `${revision}:original-ui-v1` } : {}) };
  // Invalidate pre-fix browser caches even when bootstrap first asks for metadata only.
  if (!includeMessages) return originalDetail;
  const page = await readSessionHistoryPage(detail.sessionFile, null, readHistoryPageSize());
  const ids = new Set(page.messages.map((message) => message.id));
  const lastAt = page.messages.at(-1)?.createdAt ?? -Infinity;
  // The unpersisted streaming tail still belongs to the live snapshot. Altered
  // rows are excluded there, so they cannot overwrite an original bookmarked row.
  const tail = detail.messages.filter((message) => !ids.has(message.id) && message.createdAt >= lastAt);
  const messages = stripImageDataFromMessages([...page.messages, ...tail]);
  markColdMessageWindow(messages, page.messageHistory.hasMore);
  return { ...originalDetail, messages, messageHistory: page.messageHistory };
}
