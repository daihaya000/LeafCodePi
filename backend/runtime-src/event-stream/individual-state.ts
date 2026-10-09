import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { pageTaskMessages } from "../lib/task-history";
import { readColdIndividualDetail } from "./cold-snapshot";
import { readHistoryPageSize } from "../lib/pi/history-page-size";
import { AsyncLocalStorage } from "node:async_hooks";
import { createBoundedEventWriter, serializeBoundedEvent, validateBoundedEvent } from "./bounded-writer";
import { bufferPendingSsePayload } from "../lib/sse-ready-buffer";
import { subscribeTask } from "@/lib/pi/harness";
import { getTaskDetailBounded } from "@/lib/pi/get-task-detail-bounded";
import { getBotIntercomInbox, subscribeBotIntercomInbox } from "@/lib/bot-intercom";
const FRAME=8*1024*1024, GLOBAL=16*1024*1024;
const stats={individualSubscriptions:0,individualReads:0,individualWaiters:0,individualPendingBytes:0,individualPollTimers:0};
export const readIndividualDiagnostics=()=>({...stats});
const scope=new AsyncLocalStorage<{signal:AbortSignal;close:()=>void}>();
export const runIndividualScope=<T>(signal:AbortSignal,fn:()=>T,close:()=>void=()=>{})=>scope.run({signal,close},fn);
const waiters=new Set<()=>void>();
const timers=new Set<ReturnType<typeof setTimeout>>();
export function setIndividualTimeout(fn:()=>void,ms:number){const timer=setTimeout(()=>{timers.delete(timer);stats.individualPollTimers--;fn();},ms);timers.add(timer);stats.individualPollTimers++;return timer;}
export function clearIndividualTimeout(timer:ReturnType<typeof setTimeout>){if(timers.delete(timer))stats.individualPollTimers--;clearTimeout(timer);}
export function startIndividualPoll(fn:()=>void,writer:{onCleanup(fn:()=>void):void}){stats.individualPollTimers++;const timer=setInterval(fn,2000);timer.unref?.();writer.onCleanup(()=>{clearInterval(timer);stats.individualPollTimers--;});}
export async function readIndividualDetail(id:string,options:NonNullable<Parameters<typeof getTaskDetailBounded>[1]>={}){
 assertConfigurationOwner();const signal=scope.getStore()?.signal;if(signal?.aborted)throw new Error("Stream closed");
 while(stats.individualReads>=2){
  if(waiters.size>=32)throw new Error("Snapshot busy");
  await new Promise<void>((resolve,reject)=>{const wake=()=>{signal?.removeEventListener("abort",abort);waiters.delete(wake);stats.individualWaiters--;resolve();};const abort=()=>{signal?.removeEventListener("abort",abort);waiters.delete(wake);stats.individualWaiters--;reject(new Error("Stream closed"));};waiters.add(wake);stats.individualWaiters++;signal?.addEventListener("abort",abort,{once:true});});
  if(signal?.aborted)throw new Error("Stream closed");
 }
 stats.individualReads++;try{const detail=await readColdIndividualDetail(id,options,signal??new AbortController().signal)??await getTaskDetailBounded(id,{...options,readOnly:true});if(signal?.aborted)throw new Error("Stream closed");validateBoundedEvent({...detail,messages:pageTaskMessages(detail.messages,undefined,readHistoryPageSize()).messages});return detail;}finally{stats.individualReads--;waiters.values().next().value?.();}
}
export function subscribeIndividualTask(...args:Parameters<typeof subscribeTask>){assertConfigurationOwner();const off=subscribeTask(...args);stats.individualSubscriptions++;let closed=false;return()=>{if(closed)return;closed=true;stats.individualSubscriptions--;off();};}
export function subscribeIndividualInbox(...args:Parameters<typeof subscribeBotIntercomInbox>){assertConfigurationOwner();const off=subscribeBotIntercomInbox(...args);stats.individualSubscriptions++;let closed=false;return()=>{if(closed)return;closed=true;stats.individualSubscriptions--;off();};}
export function readIndividualInbox(...args:Parameters<typeof getBotIntercomInbox>){assertConfigurationOwner();const value=getBotIntercomInbox(...args);validateBoundedEvent(value);return value;}
export function createIndividualWriter(controller:ReadableStreamDefaultController<Uint8Array>,options:{signal:AbortSignal;onTiming?:(value:{phase:string;durationMs:number})=>void}){
 assertConfigurationOwner();const writer=createBoundedEventWriter(controller,options.signal),pending=new Map<Record<string,unknown>[],number>();
 const releasePending=(items:Record<string,unknown>[])=>{const bytes=pending.get(items)??0;stats.individualPendingBytes-=bytes;pending.delete(items);items.length=0;};
 writer.onCleanup(scope.getStore()?.close??(()=>{}));
 writer.onCleanup(()=>{for(const items of pending.keys())releasePending(items);});
 return{...writer,get closed(){return writer.closed;},startHeartbeat(){},cleanup:writer.close,releasePending,
  validate(value:unknown){try{validateBoundedEvent(value);return !writer.closed;}catch{writer.close();return false;}},
  trackPending(items:Record<string,unknown>[]){try{if(items.length>64)throw Error();const bytes=Buffer.byteLength(serializeBoundedEvent(items)),old=pending.get(items)??0;if(bytes>FRAME||stats.individualPendingBytes-old+bytes>GLOBAL)throw Error();stats.individualPendingBytes+=bytes-old;pending.set(items,bytes);}catch{releasePending(items);writer.close();}},
 };
}
export function bufferIndividualPending(items:Record<string,unknown>[],payload:Record<string,unknown>,writer:ReturnType<typeof createIndividualWriter>){if(!writer.validate(payload))return;bufferPendingSsePayload(items,payload);writer.trackPending(items);}
export function sseResponse(_encoding:string|null,stream:ReadableStream<Uint8Array>,extra:Record<string,string>={}){return new Response(stream,{headers:{...extra,"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store, no-cache, no-transform","x-accel-buffering":"no","x-content-type-options":"nosniff"}});}
