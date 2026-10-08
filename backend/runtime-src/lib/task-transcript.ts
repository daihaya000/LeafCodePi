import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getTaskDetailBounded } from "./pi/get-task-detail-bounded";
import type { UiMessage } from "./types";
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
export function resetTaskTranscriptCache(){recentReads.clear();}
