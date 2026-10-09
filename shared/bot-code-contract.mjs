import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
import { publicGoalLoop } from "./task-lifecycle-contract.mjs";
export const BOT_CODE_ROUTES=Object.freeze({"bots/[id]/code-session":["GET","POST","PATCH"],"bots/[id]/code-requests":["GET","POST"]});
export function botCodeTarget(path){if(Object.hasOwn(BOT_CODE_ROUTES,path))return {route:path,params:{}};const m=/^bots\/([^/]+)\/(code-session|code-requests)$/.exec(path);if(!m)return null;try{return {route:"bots/[id]/"+m[2],params:{id:decodeURIComponent(m[1])}};}catch{return null;}}
export function botCodeBodyLimit(path){return botCodeTarget(path)?.route.endsWith("/code-session")?256*1024:4096;}
const record=v=>v!==null&&typeof v==="object"&&!Array.isArray(v),string=v=>typeof v==="string",number=v=>typeof v==="number"&&Number.isFinite(v);
function fields(v,schema){if(!record(v))return null;const out={};for(const [key,accept]of Object.entries(schema))if(v[key]!==undefined){if(!accept(v[key]))return null;out[key]=v[key];}return out;}
function report(v){const out=fields(v,{status:string,maxTurns:number,turnCount:number,acceptance:v=>Array.isArray(v)&&v.every(string),pauseReason:string,blockedReason:string,summary:string,evidence:string,rejectedClaims:number});return out&&string(out.status)?out:null;}
function result(v){if(!string(v))return null;let parsed;try{parsed=JSON.parse(v);}catch{return v;}if(!record(parsed))return v;const out=fields(parsed,{outcome:string,error:string,output:string,truncated:v=>typeof v==="boolean",codeTaskId:v=>v===null||string(v)});if(!out)return null;if(parsed.goalLoop!==undefined){out.goalLoop=report(parsed.goalLoop);if(!out.goalLoop)return null;}return JSON.stringify(out);}
function request(v){
 const out=fields(v,{id:string,codeTaskId:v=>v===null||string(v),state:v=>["queued","starting","running","ready","delivered","cancelled"].includes(v),prompt:string,queuedAt:number,outcome:string,activity:string});
 if(!out||!string(out.id)||!string(out.prompt)||out.state===undefined||out.codeTaskId===undefined)return null;
 if(v.result!==undefined){out.result=result(v.result);if(out.result===null)return null;}
 if(v.goalLoop!==undefined){out.goalLoop=report(v.goalLoop);if(!out.goalLoop)return null;}
 if(v.todoProgress!==undefined){out.todoProgress=fields(v.todoProgress,{completed:number,total:number});if(!out.todoProgress||!number(out.todoProgress.completed)||!number(out.todoProgress.total))return null;}
 if(v.goalLoopSummary!==undefined){out.goalLoopSummary=fields(v.goalLoopSummary,{status:string,maxTurns:number,turnCount:number});if(!out.goalLoopSummary||!string(out.goalLoopSummary.status)||!number(out.goalLoopSummary.maxTurns)||!number(out.goalLoopSummary.turnCount))return null;}
 return out;
}
export function publicBotCodeBody(route,v,status,method){
 if(!Object.hasOwn(BOT_CODE_ROUTES,route)||!record(v))return null;const out=fields(v,{error:string});if(!out)return null;
 if(status<400){
  if(out.error!==undefined)return null;
  if(method==="GET"&&route.endsWith("/code-session")){if(!Array.isArray(v.tasks)||!record(v.loops))return null;out.tasks=v.tasks.map(publicTaskSummary);if(out.tasks.some(v=>!v))return null;const ids=new Set(out.tasks.map(t=>t.id)),loops=[];for(const [id,value]of Object.entries(v.loops)){if(!ids.has(id))continue;const loop=value===null?null:publicGoalLoop(value);if(value!==null&&(!loop||!string(loop.status)))return null;loops.push([id,loop]);}out.loops=Object.fromEntries(loops);}
  else if(method==="GET"){if(!Array.isArray(v.requests))return null;out.requests=v.requests.map(request);if(out.requests.some(v=>!v))return null;}
  else if(route.endsWith("/code-requests")){if(!string(v.requestId)||!["queued","starting","running","ready","delivered","cancelled"].includes(v.state))return null;out.requestId=v.requestId;out.state=v.state;if(v.task!==undefined){out.task=publicTaskSummary(v.task);if(!out.task)return null;}}
  else if(v.loop!==undefined){out.loop=v.loop===null?null:publicGoalLoop(v.loop);if(v.loop!==null&&(!out.loop||!string(out.loop.status)))return null;}
  else{out.task=v.task===null?null:publicTaskSummary(v.task);if(v.task!==null&&!out.task)return null;if(method==="POST"&&out.task===null)return null;}
 }
 if(v.operation!==undefined){out.operation=publicTaskOperation(v.operation);if(!out.operation)return null;}return out;
}
