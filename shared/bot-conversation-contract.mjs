import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
import { publicGoalLoop } from "./task-lifecycle-contract.mjs";
import { publicTaskSessionBody } from "./task-session-contract.mjs";
export const BOT_CONVERSATION_ROUTES = Object.freeze(Object.fromEntries(["prompt","abort","revert"].map(action => [`bots/[id]/${action}`,["POST"]])));
export function botConversationTarget(path) {
  if (Object.hasOwn(BOT_CONVERSATION_ROUTES,path)) return { route:path,params:{} };
  const match=/^bots\/([^/]+)\/(prompt|abort|revert)$/.exec(path);if(!match)return null;
  try { return { route:`bots/[id]/${match[2]}`,params:{id:decodeURIComponent(match[1])} }; } catch { return null; }
}
export function botConversationBodyLimit(path) { return botConversationTarget(path)?.route.endsWith("/prompt") ? 18*1024*1024 : 4096; }
/** Only selected conversation/Goal outputs cross the boundary; private SDK/headers never do. */
export function publicBotConversationBody(route,value,status) {
  if(!Object.hasOwn(BOT_CONVERSATION_ROUTES,route)||!value||typeof value!=="object"||Array.isArray(value))return null;
  if(route.endsWith("/revert")) {
    const out=publicTaskSessionBody("tasks/[id]/revert",value,status);if(!out)return null;
    if(status<400){if(!Number.isInteger(value.cancelledCodeRequests)||value.cancelledCodeRequests<0)return null;out.cancelledCodeRequests=value.cancelledCodeRequests;}return out;
  }
  const out={};
  if(value.error!==undefined){if(typeof value.error!=="string")return null;out.error=value.error;}
  if(status<400) {
    if(out.error!==undefined)return null;
    if(route.endsWith("/prompt")&&value.loop!==undefined){
      if(value.task!==null)return null;out.task=null;out.loop=publicGoalLoop(value.loop);
      if(!out.loop||typeof out.loop.id!=="string"||typeof out.loop.sessionId!=="string"||!["queued","running","verifying_completed"].includes(out.loop.status))return null;
    }else{out.task=publicTaskSummary(value.task);if(!out.task)return null;}
  }
  if(value.operation!==undefined){out.operation=publicTaskOperation(value.operation);if(!out.operation)return null;}
  return out;
}
