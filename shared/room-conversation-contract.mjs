import { publicRoom } from "./room-lifecycle-contract.mjs";
import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
export const ROOM_CONVERSATION_ROUTES = Object.freeze(Object.fromEntries(["prompt","code","revert"].map(action => [`bots/rooms/[id]/${action}`,["POST"]])));
export function roomConversationTarget(path) {
  if (Object.hasOwn(ROOM_CONVERSATION_ROUTES,path)) return {route:path,params:{}};
  const match=/^bots\/rooms\/([^/]+)\/(prompt|code|revert)$/.exec(path); if(!match)return null;
  try {return {route:`bots/rooms/[id]/${match[2]}`,params:{id:decodeURIComponent(match[1])}};} catch {return null;}
}
export function roomConversationBodyLimit(path) {return roomConversationTarget(path)?.route.endsWith("/prompt")?18*1024*1024:4096;}
const record=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const string=v=>typeof v==="string";
const count=v=>Number.isSafeInteger(v)&&v>=0;
const strings=v=>Array.isArray(v)&&v.every(string);
function attachments(value, files) {
 if(!Array.isArray(value))return null;
 const out=value.map(v=>record(v)&&string(v.uri)&&string(v.mime)&&(!files||string(v.name))?{uri:v.uri,mime:v.mime,...(files?{name:v.name}:{})}:null);
 return out.includes(null)?null:out;
}
export function publicRoomConversationBody(route,value,status) {
 if(!Object.hasOwn(ROOM_CONVERSATION_ROUTES,route)||!record(value))return null;
 const out={};
 if(value.error!==undefined){if(!string(value.error))return null;out.error=value.error;}
 if(status<400) {
  if(out.error!==undefined)return null;
  if(route.endsWith("/code")) {
   if(value.task!==undefined){out.task=publicTaskSummary(value.task);if(!out.task)return null;}
   else {if(!string(value.requestId)||!["queued","starting","running","ready","delivered","cancelled"].includes(value.state))return null;out.requestId=value.requestId;out.state=value.state;}
  }else{
   out.room=publicRoom(value.room);if(!out.room)return null;
   if(route.endsWith("/revert")){
    if(!string(value.text)||!count(value.cancelledCodeRequests))return null;out.text=value.text;out.cancelledCodeRequests=value.cancelledCodeRequests;
    out.images=attachments(value.images,false);out.files=attachments(value.files,true);if(!out.images||!out.files)return null;
   }else{
    if(!strings(value.routedBotIds))return null;out.routedBotIds=[...value.routedBotIds];
    for(const [key,accept]of Object.entries({broadcast:v=>typeof v==="boolean",stopped:v=>typeof v==="boolean",stoppedTurns:count,cancelledHandoffs:count,steeredBotIds:strings,relay:v=>typeof v==="boolean",relayDepth:count,relayTurnId:string}))if(value[key]!==undefined){if(!accept(value[key]))return null;out[key]=Array.isArray(value[key])?[...value[key]]:value[key];}
   }
  }
 }
 if(value.operation!==undefined){out.operation=publicTaskOperation(value.operation);if(!out.operation)return null;}
 return out;
}
