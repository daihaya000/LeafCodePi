import { publicTaskSummary, publicTaskOperation } from "./task-collection-contract.mjs";
/** Pure authorized Task UI DTOs; arbitrary JSON is allowed only in the user's tool input content. */
export const TASK_LIFECYCLE_ROUTES = Object.freeze({ "tasks/[id]": ["GET", "PATCH", "DELETE"], "tasks/[id]/abort": ["POST"] });
export const TASK_LIFECYCLE_BODY_LIMIT = 4096;
export function taskLifecycleTarget(path) {
  if (Object.hasOwn(TASK_LIFECYCLE_ROUTES, path)) return { route: path, params: {} };
  const match = /^tasks\/([^/]+)(\/abort)?$/.exec(path); if (!match) return null;
  try { return { route: `tasks/[id]${match[2] ?? ""}`, params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
export function validTaskLifecycleId(id) { return typeof id === "string" && /^(?:[A-Za-z0-9_-]{1,128}|bot:[A-Za-z0-9_-]{1,128})$/.test(id); }
const object = v => v && typeof v === "object" && !Array.isArray(v);
const string = v => typeof v === "string", boolean = v => typeof v === "boolean", number = v => typeof v === "number" && Number.isFinite(v);
const nullable = validator => v => v === null || validator(v);
const strings = v => Array.isArray(v) && v.every(string);
const shape = (text=[], nums=[], bools=[]) => ({ ...Object.fromEntries(text.map(k=>[k,string])), ...Object.fromEntries(nums.map(k=>[k,number])), ...Object.fromEntries(bools.map(k=>[k,boolean])) });
function fields(v, schema) { if (!object(v)) throw Error("Invalid DTO"); const out={}; for(const [key, accepts] of Object.entries(schema)) if(v[key]!==undefined) { if(!accepts(v[key])) throw Error("Invalid field"); out[key]=v[key]; } return out; }
function nested(out, input, key, project) { if(input[key]!==undefined) out[key]=input[key]===null?null:project(input[key]); }
function array(value, project) { if(!Array.isArray(value)) throw Error("Invalid array"); return value.map(project); }
function json(v, depth=0) { if(depth>64) throw Error("Deep content"); if(v===null||string(v)||boolean(v)||number(v)) return v; if(Array.isArray(v))return v.map(item=>json(item,depth+1)); if(!object(v))throw Error("Non-JSON content"); return Object.fromEntries(Object.entries(v).map(([key,value])=>[key,json(value,depth+1)])); }
function toolState(v) {
  const out=fields(v,{...shape(["status","output","title","error"],["startedAtMs","endedAtMs"]),subagentRunIds:strings});
  if(!["pending","running","completed","cancelled","error"].includes(out.status))throw Error("Invalid tool status");
  if(v.input!==undefined) { if(!object(v.input))throw Error("Invalid tool input"); out.input=json(v.input); }
  if(v.nestedCalls!==undefined)out.nestedCalls=array(v.nestedCalls,call=>fields(call,shape(["id","name","status","error"],["durationMs"])));
  return out;
}
function part(v) {
  const schemas={text:shape(["id","type","text"]),thinking:shape(["id","type","text"]),image:shape(["id","type","url","mime","filename"]),file:shape(["id","type","name","mime","data","url"],["size"]),tool:shape(["id","type","tool","callID"])};
  if(!object(v)||!Object.hasOwn(schemas,v.type))throw Error("Invalid part"); const out=fields(v,schemas[v.type]); if(!string(out.id))throw Error("Invalid part ID"); if(v.type==="tool")out.state=toolState(v.state); return out;
}
function diagnostic(v) {
  const out=fields(v,shape(["type"],["timestamp"]));
  if(v.error!==undefined)out.error=fields(v.error,{...shape(["name","message"]),code:v=>string(v)||number(v)});
  if(v.details!==undefined)out.details=fields(v.details,shape(["configuredTransport","fallbackTransport","phase"],["requestBytes"],["eventsEmitted"]));
  return out;
}
function message(v) {
  const out=fields(v,shape(["id","role","accountId","agent","model","provider","error"],["createdAt","tokensBefore","inputTokens","outputTokens","tokensPerSecond","responseDurationMs"],["hangRetry","fromBot","tokensPerSecondDecode"]));
  if(!string(out.id)||!["user","assistant","compaction"].includes(out.role)||!number(out.createdAt))throw Error("Invalid message"); out.parts=array(v.parts,part);
  if(v.goalLoopTurn!==undefined)out.goalLoopTurn=fields(v.goalLoopTurn,shape(["goalId","kind"],["turn"]));
  if(v.intercom!==undefined)out.intercom=fields(v.intercom,shape(["from"]));
  if(v.diagnostics!==undefined)out.diagnostics=array(v.diagnostics,diagnostic); return out;
}
function goal(v) {
  const out=fields(v,{...shape(["id","sessionId","cwd","status","goal","turnKind","pauseReason","error","summary","evidence","blockedReason","createdAt","updatedAt"],["maxTurns","cooldownSeconds","turnCount","rejectedClaims","unreadableStreak"],["forceFullRun","autoAgent","retryInterruptedTurn","pendingTurnRecovery"]),nextTurnAt:nullable(string),acceptance:strings});
  if(v.progress!==undefined)out.progress=array(v.progress,p=>fields(p,shape(["time","status","summary","next","evidence"])));
  if(v.initialImages!==undefined)out.initialImages=array(v.initialImages,image=>fields(image,shape(["type","mimeType","data"])));
  return out;
}
function permission(v) { return fields(v,{...shape(["id","sessionId","command","message"]),labels:strings}); }
function question(v) {
  const out=fields(v,shape(["id","sessionId"])); out.questions=array(v.questions,q=>{ const result=fields(q,shape(["question","header"],[],["multiple","custom"])); result.options=array(q.options,o=>fields(o,shape(["label","description"]))); return result; }); return out;
}
export function publicUiMessages(v) { try { return array(v,message); } catch { return null; } }
export function publicTaskDetail(v) {
  try {
    const out=publicTaskSummary(v); if(!out||!boolean(v.isStreaming))return null;
    Object.assign(out,fields(v,shape(["activity"],[],["isStreaming","isCompacting","compactionSuggested"]))); out.messages=array(v.messages,message);
    if(v.messageHistory!==undefined)out.messageHistory=fields(v.messageHistory,{hasMore:boolean,nextCursor:nullable(string)});
    if(v.contextUsage!==undefined)out.contextUsage=fields(v.contextUsage,{tokens:nullable(number),contextWindow:number,percent:nullable(number)});
    nested(out,v,"goalLoop",goal); nested(out,v,"permissionRequest",permission); nested(out,v,"questionRequest",question);
    if(v.todos!==undefined)out.todos=array(v.todos,t=>fields(t,shape(["id","content","status","priority"])));
    return out;
  } catch { return null; }
}
export function publicTaskLifecycleBody(route,v,status) {
  if(!Object.hasOwn(TASK_LIFECYCLE_ROUTES,route)||!object(v))return null;
  try {
    const out=fields(v,shape(["error"],[],["ok"]));
    if(status<400) { if(v.task!==undefined){out.task=Object.hasOwn(v.task,"messages")||Object.hasOwn(v.task,"isStreaming")?publicTaskDetail(v.task):publicTaskSummary(v.task);if(!out.task)return null;} else if(out.ok!==true)return null; }
    if(v.operation!==undefined){out.operation=publicTaskOperation(v.operation);if(!out.operation)return null;} return out;
  } catch { return null; }
}
