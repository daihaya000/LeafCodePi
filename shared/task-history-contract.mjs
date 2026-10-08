import { publicUiMessages } from "./task-lifecycle-contract.mjs";
import { publicTaskOperation } from "./task-collection-contract.mjs";
export const TASK_HISTORY_ROUTES=Object.freeze({"tasks/[id]/messages":["GET"],"tasks/[id]/search":["GET"],"tasks/[id]/bookmarks":["GET","PUT","DELETE"]});
export const TASK_HISTORY_BODY_LIMIT=4000*4;
export function taskHistoryTarget(path){if(Object.hasOwn(TASK_HISTORY_ROUTES,path))return {route:path,params:{}};const m=/^tasks\/([^/]+)\/(messages|search|bookmarks)$/.exec(path);if(!m)return null;try{return {route:`tasks/[id]/${m[2]}`,params:{id:decodeURIComponent(m[1])}};}catch{return null;}}
const record=v=>v&&typeof v==="object"&&!Array.isArray(v),string=v=>typeof v==="string",number=v=>typeof v==="number"&&Number.isFinite(v),count=v=>Number.isSafeInteger(v)&&v>=0;
function bookmark(v){if(!record(v)||!string(v.messageId)||!["user","assistant"].includes(v.role)||!number(v.messageCreatedAt)||v.messageCreatedAt<0||!number(v.createdAt)||v.createdAt<0||!string(v.preview))return null;return {messageId:v.messageId,role:v.role,messageCreatedAt:v.messageCreatedAt,createdAt:v.createdAt,preview:v.preview};}
function hit(v){if(!record(v)||!string(v.messageId)||!["user","assistant"].includes(v.role)||!number(v.createdAt)||!string(v.snippet)||!count(v.count)||!Array.isArray(v.highlights)||v.highlights.some(r=>!Array.isArray(r)||r.length!==2||!r.every(count)||r[0]>r[1]||r[1]>v.snippet.length))return null;return {messageId:v.messageId,role:v.role,createdAt:v.createdAt,snippet:v.snippet,count:v.count,highlights:v.highlights.map(r=>[...r])};}
export function publicTaskHistoryBody(route,v,status){
 if(!Object.hasOwn(TASK_HISTORY_ROUTES,route)||!record(v))return null;
 const out={};if(v.error!==undefined){if(!string(v.error))return null;out.error=v.error;}
 if(status<400){
  if(route.endsWith('/messages')){const messages=publicUiMessages(v.messages),h=v.messageHistory;if(!messages||!record(h)||typeof h.hasMore!=="boolean"||!(h.nextCursor===null||string(h.nextCursor)))return null;out.messages=messages;out.messageHistory={hasMore:h.hasMore,nextCursor:h.nextCursor};}
  else if(route.endsWith('/search')){if(!Array.isArray(v.terms)||!v.terms.every(string)||!count(v.total)||typeof v.truncated!=="boolean"||!Array.isArray(v.hits))return null;out.terms=[...v.terms];out.total=v.total;out.truncated=v.truncated;out.hits=v.hits.map(hit);if(out.hits.some(x=>!x))return null;}
  else{if(!Array.isArray(v.bookmarks))return null;out.bookmarks=v.bookmarks.map(bookmark);if(out.bookmarks.some(x=>!x))return null;if(v.missing!==undefined){if(!Array.isArray(v.missing)||!v.missing.every(string))return null;out.missing=[...v.missing];}}
 }
 if(v.operation!==undefined){out.operation=publicTaskOperation(v.operation);if(!out.operation)return null;}return out;
}
