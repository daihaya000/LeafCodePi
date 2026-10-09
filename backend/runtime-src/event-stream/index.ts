import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { liveEventTarget } from "@shared/live-event-contract.mjs";
import { subscribeRoom,roomBotTaskId } from "@/lib/rooms";
import { subscribeTask,subscribeBotCodeSession,subscribeTaskDirty,linkedCodeTaskIdsForOrigin,pendingPermissionForTask,pendingQuestionForTask } from "@/lib/pi/harness";
import { subscribeRoutineRuns } from "@/lib/routines";
import { BOT_ROUTINE_RUN_EVENT,type RoomDto,type RoomMessage } from "../lib/types";
import { readRoomStreamSnapshot,readRoomAttachmentDiagnostics } from "../file-stream/room-attachments";
import { createBoundedEventWriter,readBoundedEventDiagnostics,serializeBoundedEvent } from "./bounded-writer";
const stats={active:0,subscriptions:0,pollTimers:0,pendingReads:0,retainedSnapshotBytes:0};
export function readLiveEventDiagnostics(){assertConfigurationOwner();return{...stats,...readBoundedEventDiagnostics(),...readRoomAttachmentDiagnostics(),maxActive:32};}
const fail=(status:number)=>Response.json({error:"イベントを取得できません"},{status,headers:{"cache-control":"private, no-store"}});
type Input={route:string;method:string;url:string;authorized:boolean;signal:AbortSignal};
function changedMessages(previous:RoomDto,next:RoomDto):RoomMessage[]|null{
 if(previous.id!==next.id||previous.messages.length>next.messages.length)return null;
 const changed:RoomMessage[]=[];for(let i=0;i<previous.messages.length;i++){if(previous.messages[i].id!==next.messages[i].id)return null;if(JSON.stringify(previous.messages[i])!==JSON.stringify(next.messages[i]))changed.push(next.messages[i]);}changed.push(...next.messages.slice(previous.messages.length));return changed;
}
export async function openLiveEvents(input:Input):Promise<Response>{
 assertConfigurationOwner();const target=liveEventTarget(input.route);
 if(!target)return fail(404);if(input.method!=="GET")return fail(405);
 if(process.env.LEAFCODE_PI_WEBUI_AUTH==="required"&&!input.authorized)return fail(401);
 if(input.signal.aborted)return fail(400);if(stats.active>=32)return fail(503);
 stats.active++;const lifetime=new AbortController(),abort=()=>lifetime.abort();input.signal.addEventListener("abort",abort,{once:true});
 let disposed=false;const dispose=()=>{if(disposed)return;disposed=true;stats.active--;input.signal.removeEventListener("abort",abort);lifetime.abort();};
 let initial:RoomDto|undefined;
 try{if(target.kind==="room"){stats.pendingReads++;try{initial=await readRoomStreamSnapshot(target.id,lifetime.signal);}finally{stats.pendingReads--;}}}
 catch(error){dispose();return fail(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"?404:503);}
 if(lifetime.signal.aborted){dispose();return fail(400);}
 let writer:ReturnType<typeof createBoundedEventWriter>|undefined;
 const stream=new ReadableStream<Uint8Array>({
  start(controller){
   writer=createBoundedEventWriter(controller,lifetime.signal);const out=writer;
   out.onCleanup(dispose);
   const attach=(subscribe:()=>()=>void)=>{if(out.closed)return;const off=subscribe();stats.subscriptions++;let stopped=false;out.onCleanup(()=>{if(stopped)return;stopped=true;stats.subscriptions--;off();});};
   try {
   if(target.kind==="bots"){
    attach(()=>subscribeBotCodeSession(payload=>out.send("snapshot",payload)));
    attach(()=>subscribeRoutineRuns(payload=>out.send(BOT_ROUTINE_RUN_EVENT,payload)));
    // Shared tab-wide consumers use these wakes for Sidebar and permission/question refresh.
    attach(()=>subscribeTaskDirty(payload=>out.send("task_dirty",payload)));
    return;
   }
   const taskSubs=new Map<string,()=>void>();out.onCleanup(()=>{for(const off of taskSubs.values())off();taskSubs.clear();});
   let lastRoom:RoomDto|undefined,lastRoomJson:string|undefined,lastSignature:string|undefined,busy=false,queued=false,stopped=false,snapshotBytes=0;
   out.onCleanup(()=>{stopped=true;stats.retainedSnapshotBytes-=snapshotBytes;snapshotBytes=0;lastRoom=undefined;lastRoomJson=undefined;lastSignature=undefined;initial=undefined;});
   const emit=(room:RoomDto)=>{
    if(out.closed)return;
    if(room.members.length>128){out.close();return;}
    const tasks=new Set(room.members.map(bot=>roomBotTaskId(target.id,bot)));
    for(const origin of [...tasks])for(const linked of linkedCodeTaskIdsForOrigin(origin)){tasks.add(linked);if(tasks.size>128){out.close();return;}}
    for(const [id,off]of taskSubs)if(!tasks.has(id)){off();taskSubs.delete(id);}
    for(const id of tasks)if(!taskSubs.has(id)){const off=subscribeTask(id,payload=>{if(payload.type==="snapshot")void refresh();});stats.subscriptions++;let stopped=false;taskSubs.set(id,()=>{if(stopped)return;stopped=true;stats.subscriptions--;off();});}
    const attention=room.members.map(botId=>{const taskId=roomBotTaskId(target.id,botId);return{botId,taskId,permission:pendingPermissionForTask(taskId),question:pendingQuestionForTask(taskId)};}).filter(item=>item.permission||item.question);
    const roomJson=serializeBoundedEvent(room),attentionJson=serializeBoundedEvent(attention),signature=roomJson+"\n"+attentionJson;
    if(signature===lastSignature)return;
    const retainedBytes=Buffer.byteLength(roomJson)+Buffer.byteLength(attentionJson);
    if(stats.retainedSnapshotBytes-snapshotBytes+retainedBytes>16*1024*1024){out.close();return;}
    const reused=roomJson===lastRoomJson,delta=!reused&&lastRoom?changedMessages(lastRoom,room):null;
    const metadata=delta?Object.fromEntries(Object.entries(room).filter(([key])=>key!=="messages")):null;
    const smaller=delta&&Buffer.byteLength(JSON.stringify({roomMetadata:metadata,roomMessagesDelta:delta}))<Buffer.byteLength(roomJson);
    out.send("snapshot",{type:"snapshot",...(reused?{roomReused:true}:smaller?{roomMetadata:metadata,roomMessagesDelta:delta}:{room}),attention});
    if(!out.closed){stats.retainedSnapshotBytes+=retainedBytes-snapshotBytes;snapshotBytes=retainedBytes;lastSignature=signature;lastRoom=room;lastRoomJson=roomJson;}
   };
   const refresh=async()=>{
    if(stopped||out.closed)return;if(busy){queued=true;return;}busy=true;
    try{do{queued=false;stats.pendingReads++;let room;try{room=await readRoomStreamSnapshot(target.id,lifetime.signal);}finally{stats.pendingReads--;}if(!stopped&&!out.closed)emit(room);}while(queued&&!stopped&&!out.closed);}
    catch{out.close();}finally{busy=false;}
   };
   attach(()=>subscribeRoom(target.id,()=>{void refresh();}));
   emit(initial!);initial=undefined;
   if(out.closed)return;
   stats.pollTimers++;const timer=setInterval(()=>{void refresh();},2000);timer.unref?.();out.onCleanup(()=>{clearInterval(timer);stats.pollTimers--;});
   } catch { out.close(); }
  },
  pull(){writer?.pull();},
  cancel(){writer?.close();dispose();},
 },{highWaterMark:0});
 return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store, no-cache, no-transform","x-accel-buffering":"no","x-content-type-options":"nosniff"}});
}
