import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getTaskDetailBounded } from "./pi/get-task-detail-bounded";
import type { UiMessage } from "./types";
import { getTask } from "./store";
import { pageTaskMessages } from "@shared/task-history.mjs";
import { assertSessionLoadAllowed } from "@backend-core/session-memory-guard.mjs";
import { readSessionHistoryPage, type SessionHistoryPage } from "./session-history-page";
export type TaskTranscriptRead = { ok: true; messages: UiMessage[] } | { ok: false; status: number; body: Record<string, unknown> };
const RECENT_LIMIT = 2;
const recentReads = new Map<string, { at:number; read:Promise<TaskTranscriptRead> }>();
/** Owner snapshot for registered live tasks; read-only transcript for cold/foreign/archived tasks. */
async function readTranscript(id:string):Promise<TaskTranscriptRead>{const detail=await getTaskDetailBounded(id,{readOnly:true});return {ok:true,messages:detail.messages};}
export async function readTaskTranscript(id:string,{maxAgeMs=0}:{maxAgeMs?:number}={}):Promise<TaskTranscriptRead>{
 assertConfigurationOwner();
 if(maxAgeMs<=0)return readTranscript(id);
 const now=Date.now(),recent=recentReads.get(id);if(recent&&now-recent.at<=maxAgeMs)return recent.read;
 const read=readTranscript(id);recentReads.delete(id);recentReads.set(id,{at:now,read});while(recentReads.size>RECENT_LIMIT)recentReads.delete(recentReads.keys().next().value as string);
 const forget=()=>{if(recentReads.get(id)?.read===read)recentReads.delete(id);};read.then(result=>{if(!result.ok)forget();},forget);return read;
}
/** Pagination must happen before cold history hydration, not after opening a full SDK manager. */
export async function readTaskTranscriptPage(id:string,before:string|null,limit:number,signal?:AbortSignal):Promise<SessionHistoryPage|Extract<TaskTranscriptRead,{ok:false}>>{
 assertConfigurationOwner();
 const task=getTask(id);if(!task)return{ok:false,status:404,body:{error:"タスクが見つかりません"}};
 const live=(globalThis as typeof globalThis&{__leafcodePiHarness?:{live:Map<string,{leaseLost?:boolean}>}}).__leafcodePiHarness?.live.get(id);
 if(task.status!=="archived"&&live&&!live.leaseLost){const read=await readTaskTranscript(id);return read.ok?pageTaskMessages(read.messages,before,limit):read;}
 if(!task.sessionFile)return{messages:[],messageHistory:{hasMore:false,nextCursor:null}};
 try{return await readSessionHistoryPage(task.sessionFile,before,limit,signal);}
 catch(error){
  // Only admitted legacy files use the SDK migration path. Never fall back after a budget/race refusal.
  if((error as {code?:string}).code!=="SESSION_INDEX_LEGACY")throw error;
  assertSessionLoadAllowed(task.sessionFile);
  const read=await readTaskTranscript(id);return read.ok?pageTaskMessages(read.messages,before,limit):read;
 }
}
export function resetTaskTranscriptCache(){recentReads.clear();}
