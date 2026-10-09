import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { resolvePiAgentDir } from "../lib/agents-md";
import { dataDir } from "../lib/paths";
import { PROFILE_EXPORT_POLICY as policy } from "../lib/profile";
import { MAX_ARCHIVE_BYTES } from "../lib/profile-limits";
import { rejectUnauthorizedTransfer } from "../lib/pi/transfer-access";
import { configurationRequest } from "../configuration/http";

const CHUNK=48*1024,MAX_METADATA=8*1024*1024;
const state={profileActive:0,profileDescriptors:0,profileDirectories:0,profileCompressors:0,profileMetadataBytes:0,profileBytesRead:0,profileCompressedBytes:0};
export function readProfileExportDiagnostics(){return{...state,maxProfileStreams:2,maxProfileMetadataBytes:MAX_METADATA};}
type Entry={path:string;key:string;stamp:BigIntStats;mode:number};
const refusal=(status:number)=>Object.assign(new Error("Profile export unavailable"),{status});
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(":");
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff","cross-origin-resource-policy":"same-origin"};

export async function openProfileExport(input:{url:string;method:string;headers:Record<string,string>;authorized:boolean;signal:AbortSignal},onClose:()=>Promise<void>=async()=>{}):Promise<Response>{
 assertConfigurationOwner();
 const denied=rejectUnauthorizedTransfer(configurationRequest(new Request(input.url,{method:input.method,headers:input.headers}),input.authorized));if(denied)return denied;
 if(state.profileActive>=2)return Response.json({error:"設定の配信が混雑しています"},{status:503,headers});
 state.profileActive++;const records:Entry[]=[];let metadata=0,released=false;
 const release=()=>{if(!released){released=true;state.profileActive--;state.profileMetadataBytes-=metadata;records.length=0;void onClose();}};
 const deadline=Date.now()+120000,inventoryDeadline=Date.now()+8000;
 const check=(inventory=false)=>{input.signal.throwIfAborted();if(Date.now()>(inventory?inventoryDeadline:deadline))throw refusal(503);};
 let total=0;
 try{
  check(true);
  if(new URL(input.url).searchParams.has("backups")){
   const rows:Array<{name:string;createdAt:string;time:number}>=[],path=join(dataDir(),"profile-backups");
   let dir;try{if(await realpath(path)!==resolve(path))throw refusal(403);dir=await opendir(path);}catch(error){if((error as any).code!=="ENOENT")throw error;}
   if(dir){state.profileDirectories++;try{for await(const entry of dir){check(true);if(!entry.isFile()||!/^leafcode-pi-profile-.*\.bak\.lcp\.gz$/.test(entry.name))continue;if(rows.length>=512||entry.name.length>512)throw refusal(413);const info=await lstat(join(path,entry.name));if(!info.isFile())continue;rows.push({name:entry.name,createdAt:info.mtime.toISOString(),time:info.mtimeMs});}}finally{state.profileDirectories--;}}
   rows.sort((a,b)=>b.time-a.time);const result={backups:rows.map(({name,createdAt})=>({name,createdAt}))};if(Buffer.byteLength(JSON.stringify(result))>65536)throw refusal(413);release();return input.method==="HEAD"?new Response(null,{headers:{...headers,"content-type":"application/json"}}):Response.json(result,{headers});
  }
  async function add(root:string,path:string,kind:string){
   check(true);let info:BigIntStats;try{info=await lstat(path,{bigint:true});}catch(error){if((error as any).code==="ENOENT")return;throw error;}
   if(!info.isFile())return;
   if(await realpath(path)!==resolve(path))throw refusal(403);
   const key=kind+"/"+relative(root,path).replaceAll("\\","/");if(key.length>4096)throw refusal(413);
   if(key.split("/").some(part=>!part||part==="."||part==="..")||key.includes("\0"))throw refusal(403);
   total+=Number(info.size);if(total>policy.maxContentBytes||records.length>=policy.maxFiles)throw refusal(413);
   const charge=320+path.length*2+key.length*2;if(metadata+charge>MAX_METADATA)throw refusal(413);metadata+=charge;state.profileMetadataBytes+=charge;
   records.push({path,key,stamp:info,mode:Number(info.mode&0o777n)});
  }
  async function walk(root:string,path:string,kind:string,depth=0){
   check(true);let info;try{info=await lstat(path);}catch(error){if((error as any).code==="ENOENT")return;throw error;}
   if(!info.isDirectory()||info.isSymbolicLink())return;if(depth>=32)throw refusal(413);if(await realpath(path)!==resolve(path))throw refusal(403);
   const dir=await opendir(path);state.profileDirectories++;try{for await(const entry of dir){check(true);if(entry.isSymbolicLink())continue;const child=join(path,entry.name);if(entry.isDirectory())await walk(root,child,kind,depth+1);else if(entry.isFile())await add(root,child,kind);}}finally{state.profileDirectories--;}
  }
  for(const [kind,root,files,dirs]of [["agent",resolve(resolvePiAgentDir()),policy.agentFiles,policy.agentDirectories],["data",resolve(dataDir()),policy.dataFiles,policy.dataDirectories]] as const){
   let canonical;try{canonical=await realpath(root);}catch(error){if((error as any).code==="ENOENT")continue;throw error;}if(canonical!==root)throw refusal(403);
   for(const name of files)await add(root,join(root,name),kind);for(const name of dirs)await walk(root,join(root,name),kind);
  }
  check(true);
  const outputHeaders={...headers,"content-type":"application/gzip","content-disposition":`attachment; filename="leafcode-pi-profile-${new Date().toISOString().replaceAll(/[:.]/g,"-")}.lcp.gz"`,"accept-ranges":"none"};
  if(input.method==="HEAD"){release();return new Response(null,{headers:outputHeaders});}
  async function* json(){
   const encode=(text:string)=>Buffer.from(text,"utf8");
   yield encode(`{"format":${JSON.stringify(policy.format)},"version":${policy.version},"createdAt":${JSON.stringify(new Date().toISOString())},"files":{`);
   for(let i=0;i<records.length;i++){
    check();const item=records[i];yield encode((i?",":"")+JSON.stringify(item.key)+':"');
    if(await realpath(item.path)!==resolve(item.path))throw refusal(409);
    const file=await open(item.path,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NONBLOCK|constants.O_NOFOLLOW));state.profileDescriptors++;
    try{
     const before=await file.stat({bigint:true}),named=await stat(item.path,{bigint:true});if(!before.isFile()||stamp(before)!==stamp(item.stamp)||stamp(named)!==stamp(before)||await realpath(item.path)!==resolve(item.path))throw refusal(409);
     const buffer=Buffer.allocUnsafe(CHUNK);let position=0;
     while(position<Number(before.size)){check();const length=Math.min(CHUNK,Number(before.size)-position),part=await file.read(buffer,0,length,position);if(part.bytesRead!==length)throw refusal(409);position+=length;state.profileBytesRead+=length;yield encode(buffer.subarray(0,length).toString("base64"));}
     if(stamp(await file.stat({bigint:true}))!==stamp(before)||stamp(await stat(item.path,{bigint:true}))!==stamp(before)||await realpath(item.path)!==resolve(item.path))throw refusal(409);
    }finally{try{await file.close();}finally{state.profileDescriptors--;}}
    yield encode('"');
   }
   yield encode('},"modes":{');for(let i=0;i<records.length;i++){check();yield encode((i?",":"")+JSON.stringify(records[i].key)+":"+records[i].mode);}yield encode("}}");
  }
  let expanded=0;async function* bounded(){for await(const bytes of json()){expanded+=bytes.length;if(expanded>policy.maxExpandedBytes)throw refusal(413);yield bytes;}}
  const controller=new AbortController(),source=Readable.from(bounded(),{objectMode:false,highWaterMark:65536}),gzip=createGzip({level:1,chunkSize:65536});state.profileCompressors++;
  const run=pipeline(source,gzip,{signal:controller.signal});void run.catch(()=>{});const iterator=gzip[Symbol.asyncIterator]();let closed:Promise<void>|undefined;
  const close=()=>closed??=(async()=>{input.signal.removeEventListener("abort",abort);controller.abort();gzip.destroy();source.destroy();await iterator.return?.().catch(()=>{});await run.catch(()=>{});state.profileCompressors--;release();})();
  const abort=()=>{void close();};input.signal.addEventListener("abort",abort,{once:true});if(input.signal.aborted)abort();let compressed=0;
  const body=new ReadableStream<Uint8Array>({async pull(output){try{check();const part=await iterator.next();if(part.done){await close();output.close();return;}if(part.value.length>65536)throw refusal(503);compressed+=part.value.length;if(compressed>MAX_ARCHIVE_BYTES)throw refusal(413);state.profileCompressedBytes+=part.value.length;output.enqueue(part.value);}catch{await close();output.error(new Error("Profile stream unavailable"));}},async cancel(){await close();}},{highWaterMark:0});
  return new Response(body,{headers:outputHeaders});
 }catch(error){release();return Response.json({error:"設定の配信を開始できません"},{status:typeof(error as any).status==="number"?(error as any).status:input.signal.aborted?400:503,headers});}
}
