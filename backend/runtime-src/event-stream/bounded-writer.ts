const CHUNK=65536, FRAME=8*1024*1024, GLOBAL=16*1024*1024, MAX_QUEUED_FRAMES=64;
const stats={writers:0,queuedBytes:0,peakQueuedBytes:0,queuedFrames:0,peakQueuedFrames:0,heartbeats:0,stallTimers:0,overflows:0};
export const readBoundedEventDiagnostics=()=>({...stats,maxFrameBytes:FRAME,maxGlobalQueuedBytes:GLOBAL,maxQueuedFrames:MAX_QUEUED_FRAMES});
/** Reject before allocating the complete encoded frame, including JSON string escaping. */
function checkedEvent(value:unknown,max=FRAME,validationOnly=false):string {
 let budget=0,nodes=0;
 const stringBytes=(text:string)=>{
  if(text.length>max)throw new Error("Event size");
  let bytes=Buffer.byteLength(text)+2;
  for(let i=0;i<text.length;i++){
   const code=text.charCodeAt(i);
   if(code===34||code===92)bytes++;
   else if(code<32)bytes+=code===8||code===9||code===10||code===12||code===13?1:5;
   else if(code>=0xd800&&code<=0xdbff){const next=text.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff)i++;else bytes+=3;}
   else if(code>=0xdc00&&code<=0xdfff)bytes+=3;
   if(bytes>max)throw new Error("Event size");
  }
  return bytes;
 };
 const json=JSON.stringify(value,(key,item)=>{
  if(++nodes>300000)throw new Error("Event complexity");
  budget+=stringBytes(key)+(typeof item==="string"?stringBytes(item):16);
  if(budget>max)throw new Error("Event size");return validationOnly&&typeof item==="string"?"":item;
 });
 if(json===undefined)throw new Error("Invalid event");
 return json;
}
/** Validation visits the actual values/escaping budget but never copies payload strings into its output. */
export function validateBoundedEvent(value:unknown,max=FRAME):void { checkedEvent(value,max,true); }
export function serializeBoundedEvent(value:unknown,max=FRAME):string { return checkedEvent(value,max); }
export function createBoundedEventWriter(controller:ReadableStreamDefaultController<Uint8Array>,signal:AbortSignal,options:{stallMs?:number;heartbeatMs?:number;maxFrameBytes?:number}={}){
 const encoder=new TextEncoder(),queue:Uint8Array[]=[];let offset=0,demand=false,closed=false,queuedBytes=0;
 let stall:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;const cleanups:Array<()=>void>=[];
 stats.writers++;
 const clearStall=()=>{if(stall){clearTimeout(stall);stall=undefined;stats.stallTimers--;}};
 const close=()=>{if(closed)return;closed=true;clearStall();if(heartbeat){clearInterval(heartbeat);heartbeat=undefined;stats.heartbeats--;}stats.queuedBytes-=queuedBytes;queuedBytes=0;stats.queuedFrames-=queue.length;queue.length=0;stats.writers--;signal.removeEventListener("abort",close);for(const fn of cleanups.splice(0))try{fn();}catch{}try{controller.close();}catch{}};
 const arm=(progress=false)=>{if(progress||!queue.length)clearStall();if(queue.length&&!stall){stats.stallTimers++;stall=setTimeout(close,options.stallMs??45000);stall.unref?.();}};
 const pump=()=>{if(closed||!demand||!queue.length)return;const head=queue[0],end=Math.min(head.length,offset+CHUNK);demand=false;try{controller.enqueue(head.slice(offset,end));offset=end;if(offset===head.length){queue.shift();stats.queuedFrames--;offset=0;queuedBytes-=head.length;stats.queuedBytes-=head.length;}arm(true);}catch{close();}};
 const enqueue=(bytes:Uint8Array)=>{if(closed)return;if(queue.length>=MAX_QUEUED_FRAMES||bytes.length>(options.maxFrameBytes??FRAME)||queuedBytes+bytes.length>FRAME||stats.queuedBytes+bytes.length>GLOBAL){stats.overflows++;close();return;}queue.push(bytes);stats.queuedFrames++;stats.peakQueuedFrames=Math.max(stats.peakQueuedFrames,stats.queuedFrames);queuedBytes+=bytes.length;stats.queuedBytes+=bytes.length;stats.peakQueuedBytes=Math.max(stats.peakQueuedBytes,stats.queuedBytes);arm();pump();};
 const writer={
  get closed(){return closed;},
  onCleanup(fn:()=>void){if(closed)fn();else cleanups.push(fn);},
  pull(){if(closed)return;demand=true;pump();},
  sendSerialized(event:string,json:string){if(closed)return;const available=Math.min(options.maxFrameBytes??FRAME,FRAME-queuedBytes,GLOBAL-stats.queuedBytes);if(!/^[a-zA-Z0-9_-]{1,64}$/.test(event)||json.length>available||Buffer.byteLength(json)+event.length+16>available){stats.overflows++;close();return;}// Encode fragments into one exact owned frame; flattening an interpolated
   // UTF-16 payload first would duplicate every large JSON string.
   const prefix=`event: ${event}\ndata: `,bytes=new Uint8Array(prefix.length+Buffer.byteLength(json)+2);
   encoder.encodeInto(prefix,bytes);encoder.encodeInto(json,bytes.subarray(prefix.length));bytes[bytes.length-2]=10;bytes[bytes.length-1]=10;enqueue(bytes);},
  send(event:string,data:unknown){if(closed)return;try{
   writer.sendSerialized(event,serializeBoundedEvent(data,Math.min(options.maxFrameBytes??FRAME,FRAME-queuedBytes,GLOBAL-stats.queuedBytes)-event.length-16));
  }catch{stats.overflows++;close();}},
  heartbeat(){if(!closed)enqueue(encoder.encode(": ping\n\n"));},
  close,
 };
 signal.addEventListener("abort",close,{once:true});
 if(signal.aborted)close();else{stats.heartbeats++;heartbeat=setInterval(writer.heartbeat,options.heartbeatMs??15000);heartbeat.unref?.();enqueue(encoder.encode(": connected\n\n"));}
 return writer;
}
