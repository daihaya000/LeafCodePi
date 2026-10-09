import type { UiMessage } from "./types";
import { pageTaskMessages as pageMessages } from "@shared/task-history.mjs";
const coldWindows = new WeakMap<readonly UiMessage[], boolean>();
export function markColdMessageWindow(messages: UiMessage[], hasMore: boolean) { coldWindows.set(messages, hasMore); }
export function pageTaskMessages(messages: UiMessage[], before?: string | null, limit?: number) {
 const page = pageMessages(messages, before, limit);
 if (!before && coldWindows.get(messages)) page.messageHistory = { hasMore: true, nextCursor: page.messages[0]?.id ?? null };
 return page;
}
/** Keep the existing paged snapshot/reset wire contract in the owner. */
export function pageTaskSnapshotPayload(payload:Record<string,unknown>,limit?:number):Record<string,unknown>{
 if(payload.type!=="snapshot"||!Array.isArray(payload.messages))return payload;
 const page=pageTaskMessages(payload.messages as UiMessage[],undefined,limit);
 return{...payload,messages:page.messages,messageHistory:page.messageHistory,...(["revert","unrevert","conversation_reset"].includes(String(payload.eventType))?{historyReset:true}:{})};
}
