import { join } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { admitTtsAudio,completeTtsAudio } from "@backend-core/tts-audio-command.mjs";
import { TTS_AUDIO_BODY_LIMIT,TTS_AUDIO_OPERATION_HEADER,TTS_AUDIO_EXECUTION_HEADER } from "@shared/tts-audio-contract.mjs";
import { dataDir } from "../lib/paths";import { configurationRequest } from "../configuration/http";
import { POST } from "../json-business/handlers/tts/synthesize/route";
import { TTS_MAX_AUDIO_BYTES } from "../lib/tts-synthesize";
const state={ttsActive:0,ttsReaders:0,ttsHeldChunkBytes:0,ttsBytesRead:0};
export function readTtsAudioDiagnostics(){return{...state,maxTtsStreams:2,maxTtsAudioBytes:TTS_MAX_AUDIO_BYTES};}
type Input={url:string;headers:Record<string,string>;authorized:boolean;operationId?:string;body?:Uint8Array;signal:AbortSignal};
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff","cross-origin-resource-policy":"same-origin","accept-ranges":"none"};
export async function openTtsAudio(input:Input,onClose:()=>Promise<void>):Promise<Response>{
 assertConfigurationOwner();const failure=(status:number,execution="not-started")=>Response.json({error:"音声処理の結果を確認できません",execution},{status,headers});
 if(input.headers.origin && input.headers.origin!==new URL(input.url).origin)return failure(403);
 if(input.signal.aborted)return failure(400);if((input.body?.length??0)>TTS_AUDIO_BODY_LIMIT)return failure(413);
 if(state.ttsActive>=2)return failure(503);
 const path=join(dataDir(),"tts-synthesis-command.json"),id=input.operationId??"",receipt=admitTtsAudio(path,id);
 if(receipt.status!==200)return failure(receipt.status,receipt.execution);
 state.ttsActive++;let released=false;const release=async()=>{if(!released){released=true;state.ttsActive--;await onClose();}};
 let source:Response;
 try{
  // Once admitted, request cancellation does not abort the accepted engine request.
  source=await POST(configurationRequest(new Request(input.url,{method:"POST",headers:input.headers,body:new Uint8Array(input.body??[]).slice().buffer}),input.authorized));
 }catch{await release();return failure(503,"unknown");}
 if(!source.ok){await source.body?.cancel().catch(()=>{});const preflight=source.status<500;if(preflight&&!completeTtsAudio(path,id)){await release();return failure(503,"unknown");}await release();return failure(source.status<500?source.status:502,preflight?"complete":"unknown");}
 if(input.signal.aborted){await source.body?.cancel().catch(()=>{});await release();return failure(400,"unknown");}
 const declared=Number(source.headers.get("content-length")),encoded=source.headers.has("content-encoding");
 if(Number.isFinite(declared)&&declared>TTS_MAX_AUDIO_BYTES){await source.body?.cancel().catch(()=>{});await release();return failure(502,"unknown");}
 const rawType=source.headers.get("content-type")?.split(";")[0]?.trim()??"";
 const mime=rawType==="application/octet-stream"||/^audio\/[A-Za-z0-9.+-]+$/.test(rawType)?rawType:"audio/wav";
 const reader=source.body?.getReader();if(reader)state.ttsReaders++;let closing:Promise<void>|undefined,chunk:Uint8Array|undefined,offset=0,total=0;
 const clear=()=>{if(chunk){state.ttsHeldChunkBytes-=chunk.length;chunk=undefined;offset=0;}};
 const close=()=>closing??=(async()=>{input.signal.removeEventListener("abort",abort);clear();await reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{}if(reader)state.ttsReaders--;await release();})();
 const abort=()=>{void close();};input.signal.addEventListener("abort",abort,{once:true});if(input.signal.aborted)abort();
 const body=new ReadableStream<Uint8Array>({async pull(output){try{
  if(closing)throw Error();
  if(!chunk){const part=reader?await reader.read():{done:true,value:undefined};if(closing)throw Error();if(part.done){if(!encoded&&source.headers.has("content-length")&&Number.isFinite(declared)&&total!==declared)throw Error();if(!completeTtsAudio(path,id))throw Error();await close();output.close();return;}
   if(!part.value||part.value.length>256*1024)throw Error();total+=part.value.length;if(total>TTS_MAX_AUDIO_BYTES)throw Error();chunk=part.value;state.ttsHeldChunkBytes+=chunk.length;state.ttsBytesRead+=chunk.length;
  }
  const end=Math.min(offset+65536,chunk.length),bytes=chunk.subarray(offset,end);offset=end;if(offset===chunk.length)clear();output.enqueue(bytes);
 }catch{await close();output.error(new Error("Audio stream closed"));}},async cancel(){await close();}},{highWaterMark:0});
 // No Content-Length: a clean chunked EOF only follows the persisted completion checkpoint.
 return new Response(body,{headers:{...headers,"content-type":mime,[TTS_AUDIO_OPERATION_HEADER]:id,[TTS_AUDIO_EXECUTION_HEADER]:"unknown"}});
}
