import type { UiMessage } from "./types";
import { pageTaskMessages } from "@shared/task-history.mjs";
export { pageTaskMessages } from "@shared/task-history.mjs";
/** Keep the existing paged snapshot/reset wire contract in the owner. */
export function pageTaskSnapshotPayload(payload:Record<string,unknown>,limit?:number):Record<string,unknown>{
 if(payload.type!=="snapshot"||!Array.isArray(payload.messages))return payload;
 const page=pageTaskMessages(payload.messages as UiMessage[],undefined,limit);
 return{...payload,messages:page.messages,messageHistory:page.messageHistory,...(["revert","unrevert","conversation_reset"].includes(String(payload.eventType))?{historyReset:true}:{})};
}
