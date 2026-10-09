import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getTask } from "@/lib/store";
import { isAgentSwitchMarker, isGoalLoopTurnMarker, isIntercomMessageMarker, piRawMessageProjectsToUi } from "../lib/pi/messages";
import { imageMimeFromBytes } from "../lib/raster-image";
import type { StoredImage } from "./stored-images";

const MIB=1024*1024, MAX_IMAGE=8*MIB, MAX_LINE=16*MIB, MAX_FILE=512*MIB, MAX_INDEX=8*MIB, MAX_HELD=32*MIB;
const diagnostics={imageReaders:0,imageWaiters:0,imageDescriptors:0,heldImageBytes:0,heldImages:0,scanBytes:0,peakIndexBytes:0,scanBufferBytes:0};
export function readMessageImageDiagnostics(){return{...diagnostics,imageIndexCacheBytes:cacheBytes,imageIndexCacheEntries:indexes.size,maxMessageImageBytes:MAX_IMAGE,maxMessageImageScanBytes:MAX_FILE};}
type Row={id:string;parentId:string|null;raw:boolean;prefix?:string};
type Manager={getLeafId():string|null;getEntry(id:string):any};
type Live={leaseLost?:boolean;session:{sessionManager:Manager;sessionFile?:string}};
const refusal=(status:number)=>Object.assign(new Error("Transcript image unavailable"),{status});
const waiting:Array<()=>void>=[];
let scanBuffer:Buffer|undefined;
async function lease(signal:AbortSignal){
 signal.throwIfAborted();
 if(diagnostics.imageReaders){
  if(waiting.length>=32)throw refusal(503);
  await new Promise<void>((resolve,reject)=>{diagnostics.imageWaiters++;const abort=()=>{const at=waiting.indexOf(ready);if(at>=0){waiting.splice(at,1);diagnostics.imageWaiters--;reject(signal.reason);}};const ready=()=>{signal.removeEventListener("abort",abort);diagnostics.imageWaiters--;resolve();};waiting.push(ready);signal.addEventListener("abort",abort,{once:true});});
 }else diagnostics.imageReaders++;
 return()=>{const next=waiting.shift();if(next)next();else diagnostics.imageReaders--;};
}
function rawEntry(entry:any):any{
 if(entry?.type==="message")return entry.message;
 if(entry?.type==="compaction")return{role:"compactionSummary"};
 if(entry?.type!=="custom_message")return null;
 const raw={role:"custom",id:entry.id,customType:entry.customType,content:entry.content,display:entry.display,details:entry.details};
 return piRawMessageProjectsToUi(raw)||isGoalLoopTurnMarker(raw)||isAgentSwitchMarker(raw)||isIntercomMessageMarker(raw)?raw:null;
}
function row(entry:any):Row|null{
 if(!entry||entry.type==="session")return null;
 if(typeof entry.id!=="string"||!entry.id||entry.id.length>512||(entry.parentId!==null&&(typeof entry.parentId!=="string"||entry.parentId.length>512)))throw refusal(409);
 const raw=rawEntry(entry);
 return{id:entry.id,parentId:entry.parentId,raw:Boolean(raw),prefix:raw&&typeof raw.id==="string"&&raw.id?raw.id:undefined};
}
function selectedData(entry:any,prefix:string,partId:string):{data:string;mime:string}|null{
 const raw=rawEntry(entry);
 if(!raw||!(raw.role==="user"||raw.role==="custom"&&piRawMessageProjectsToUi(raw)))return null;
 const parts=Array.isArray(raw.content)?raw.content:[];
 for(let i=0;i<parts.length;i++){const p=parts[i];if(p?.type==="image"&&partId===prefix+"-image-"+i&&typeof p.data==="string"&&p.data)return{data:p.data,mime:typeof p.mimeType==="string"&&p.mimeType?p.mimeType:"image/png"};}
 return null;
}
function prefixFor(target:string,leaf:string|null,lookup:(id:string)=>Row|undefined){
 const branch:Row[]=[],seen=new Set<string>();let bytes=0;
 for(let id=leaf;id;){
  if(seen.has(id)||seen.size>=100000)throw refusal(409);seen.add(id);
  const item=lookup(id);if(!item)throw refusal(409);
  bytes+=256+item.id.length*2+(item.parentId?.length??0)*2+(item.prefix?.length??0)*2;if(bytes>MAX_INDEX)throw refusal(413);
  branch.push(item);id=item.parentId;
 }
 let ordinal=0;for(let i=branch.length-1;i>=0;i--){const item=branch[i];if(item.id===target)return item.raw?(item.prefix??"msg-"+ordinal):null;if(item.raw)ordinal++;}
 return null;
}
function encodedImage(selected:{data:string;mime:string}):StoredImage{
 let data:string|undefined=selected.data;const mime=selected.mime;
 if(data.length>4*Math.ceil(MAX_IMAGE/3))throw refusal(413);
 if(!data.length||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw refusal(415);
 const padding=data.endsWith("==")?2:data.endsWith("=")?1:0,size=data.length/4*3-padding;
 if(!size||size>MAX_IMAGE)throw refusal(413);
 if(padding){const digit="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(data.at(-padding-1)!);if(digit&(padding===2?15:3))throw refusal(415);}
 if(imageMimeFromBytes(Buffer.from(data.slice(0,44),"base64"))!==mime)throw refusal(415);
 const charge=data.length;if(diagnostics.heldImageBytes+charge>MAX_HELD)throw refusal(503);
 diagnostics.heldImageBytes+=charge;diagnostics.heldImages++;
 return{size,mime,cacheControl:"private, no-store",read(position,length){if(!data)throw refusal(503);const start=Math.floor(position/3)*4,end=Math.ceil((position+length)/3)*4;return Buffer.from(data.slice(start,end),"base64").subarray(position%3,position%3+length);},release(){if(data!==undefined){data=undefined;diagnostics.heldImageBytes-=charge;diagnostics.heldImages--;}}};
}
type IndexedRow=Row&{offset:number;length:number};
type ImageIndex={version:string;leaf:string|null;rows:Map<string,IndexedRow>;bytes:number};
const indexes=new Map<string,ImageIndex>();
let cacheBytes=0;
function rememberIndex(path:string,item:ImageIndex){
 const previous=indexes.get(path);if(previous){cacheBytes-=previous.bytes;indexes.delete(path);}
 while(indexes.size>=4||cacheBytes+item.bytes>MAX_INDEX){const first=indexes.keys().next().value as string|undefined;if(first===undefined)break;cacheBytes-=indexes.get(first)!.bytes;indexes.delete(first);}
 indexes.set(path,item);cacheBytes+=item.bytes;
}
/** One verified descriptor; cache only bounded ancestry/offsets, never message text or image bytes. */
async function coldImage(path:string,messageId:string,partId:string,signal:AbortSignal):Promise<StoredImage>{
 let file:FileHandle|undefined;
 try{
  if(!isAbsolute(path)||await realpath(path)!==resolve(path))throw refusal(403);
  file=await open(path,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NONBLOCK|constants.O_NOFOLLOW));diagnostics.imageDescriptors++;
  const before=await file.stat({bigint:true}),named=await stat(path,{bigint:true});
  if(!before.isFile()||before.ino!==named.ino||before.dev!==named.dev||await realpath(path)!==resolve(path))throw refusal(403);
  if(before.size>BigInt(MAX_FILE))throw refusal(413);
  const version=(s:typeof before)=>[s.ino,s.dev,s.size,s.mtimeNs,s.ctimeNs].join(":");
  if(!scanBuffer){scanBuffer=Buffer.allocUnsafe(MAX_LINE);diagnostics.scanBufferBytes=scanBuffer.length;}
  const scratch=Buffer.allocUnsafe(65536),until=Date.now()+8000;
  const check=()=>{signal.throwIfAborted();if(Date.now()>until)throw refusal(503);};
  let index=indexes.get(path);
  if(index?.version!==version(before)){
   const previous=indexes.get(path);if(previous){cacheBytes-=previous.bytes;indexes.delete(path);}
   const rows=new Map<string,IndexedRow>();let used=0,offset=0,leaf:string|null=null,header=false,indexBytes=0;
   const emit=(lineEnd:number)=>{
    if(!used)return;let entry:any;try{entry=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(scanBuffer!.subarray(0,used)));}catch{used=0;return;}const length=used;used=0;
    if(!header){if(entry?.type!=="session"||entry.version!==3)throw refusal(409);header=true;return;}
    if(entry?.type==="session")throw refusal(409);
    const item=row(entry);if(!item)return;
    if(rows.has(item.id))throw refusal(409);
    indexBytes+=272+item.id.length*2+(item.parentId?.length??0)*2+(item.prefix?.length??0)*2;
    if(indexBytes>MAX_INDEX||rows.size>=100000)throw refusal(413);
    rows.set(item.id,{...item,offset:lineEnd-length,length});diagnostics.peakIndexBytes=Math.max(diagnostics.peakIndexBytes,indexBytes);leaf=item.id;
   };
   while(offset<Number(before.size)){
    check();const n=Math.min(scratch.length,Number(before.size)-offset),part=await file.read(scratch,0,n,offset);if(part.bytesRead!==n)throw refusal(409);diagnostics.scanBytes+=n;
    let start=0;while(start<n){let end=scratch.indexOf(10,start);if(end<0||end>=n)end=n;const count=end-start;if(used+count>MAX_LINE)throw refusal(413);scratch.copy(scanBuffer,used,start,end);used+=count;if(end<n){emit(offset+end);start=end+1;}else start=n;}
    offset+=n;
   }
   emit(offset);check();if(!header)throw refusal(409);
   index={version:version(before),leaf,rows,bytes:indexBytes};
  }
  const prefix=prefixFor(messageId,index.leaf,id=>index!.rows.get(id)),target=index.rows.get(messageId);
  if(prefix===null||!target)throw refusal(404);
  let read=0;while(read<target.length){check();const n=Math.min(65536,target.length-read),item=await file.read(scanBuffer,read,n,target.offset+read);if(item.bytesRead!==n)throw refusal(409);diagnostics.scanBytes+=n;read+=n;}
  const entry=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(scanBuffer.subarray(0,target.length)));
  if(entry?.id!==messageId)throw refusal(409);
  check();const current=await file.stat({bigint:true}),currentName=await stat(path,{bigint:true});
  if(version(current)!==version(before)||version(currentName)!==version(before)||await realpath(path)!==resolve(path))throw refusal(409);
  rememberIndex(path,index);
  const selected=selectedData(entry,prefix,partId);if(!selected)throw refusal(404);return encodedImage(selected);
 }finally{if(file){try{await file.close();}finally{diagnostics.imageDescriptors--;}}}
}
export async function openMessageImage(id:string,url:string,signal:AbortSignal):Promise<{ok:true;image:StoredImage}|{ok:false;status:number;error:string}>{
 assertConfigurationOwner();const query=new URL(url).searchParams,messageId=(query.get("messageId")??"").trim(),partId=(query.get("partId")??"").trim();
 if(!messageId||!partId||messageId.length>512||partId.length>512)return{ok:false,status:400,error:"画像のパラメータが不正です"};
 let release:(()=>void)|undefined;
 try{
  signal.throwIfAborted();const task=getTask(id);if(!task)throw refusal(404);
  release=await lease(signal);signal.throwIfAborted();
  const holder=(globalThis as typeof globalThis&{__leafcodePiHarness?:{live:Map<string,Live>}}).__leafcodePiHarness;
  const live=task.status!=="archived"?holder?.live?.get(id):undefined;
  let image:StoredImage;
  if(live&&!live.leaseLost){
   const manager=live.session.sessionManager,leaf=manager.getLeafId();
   const prefix=prefixFor(messageId,leaf,id=>{const entry=manager.getEntry(id);return entry?row(entry)??undefined:undefined;});
   const selected=prefix===null?null:selectedData(manager.getEntry(messageId),prefix,partId);
   if(!selected)throw refusal(404);if(manager.getLeafId()!==leaf)throw refusal(409);image=encodedImage(selected);
  }else{if(!task.sessionFile)throw refusal(404);image=await coldImage(task.sessionFile,messageId,partId,signal);}
  if(signal.aborted){image.release();throw refusal(400);}return{ok:true,image};
 }catch(error){const status=typeof(error as any)?.status==="number"?(error as any).status:signal.aborted?400:(error as any)?.code==="ENOENT"?404:503;return{ok:false,status,error:"画像を取得できません"};}
 finally{release?.();}
}
