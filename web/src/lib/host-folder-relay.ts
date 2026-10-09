import { HOST_FOLDER_PATH, HOST_FOLDER_HEADER, HOST_FOLDER_BODY_LIMIT, publicHostFolderBody } from "@shared/host-folder-contract.mjs";
import { resolveHostControlUrl } from "@/lib/host-control";
import { isCrossOriginRequest } from "@/lib/same-origin";
import { isWebUiRequestAuthorized, webUiAuthRequired } from "@/lib/webui-auth";
const fail=(status:number,error:string,execution?:string)=>Response.json({error,...(execution?{execution}:{})},{status,headers:{"cache-control":"no-store, private"}});
/** Opaque Host transport: no native process, selected-path lookup, business parsing, retry or fallback. */
export async function relayHostFolderSelection(request:Request):Promise<Response>{
 if(request.method!=="POST")return fail(405,"許可されないメソッドです");
 if(webUiAuthRequired()&&!isWebUiRequestAuthorized(request))return fail(401,"認証が必要です");
 if(isCrossOriginRequest({headers:request.headers,nextUrl:new URL(request.url)}))return fail(403,"許可されない接続元です");
 const chunks:Uint8Array[]=[];let size=0;
 try{if(request.body){const reader=request.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>HOST_FOLDER_BODY_LIMIT){await reader.cancel();return fail(413,"本文が大きすぎます");}chunks.push(value);}}finally{reader.releaseLock();}}}catch{return fail(400,"本文を読み込めません");}
 if(request.signal.aborted)return fail(400,"リクエストが中断されました");
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const response=await fetch(resolveHostControlUrl()+HOST_FOLDER_PATH,{method:"POST",headers:{[HOST_FOLDER_HEADER]:"1","content-type":"application/json"},...(size?{body:bytes.buffer}:{}),signal:AbortSignal.any([request.signal,AbortSignal.timeout(130000)]),cache:"no-store"});
  if(response.status===404){await response.body?.cancel();return fail(501,"フォルダ選択にHostが未対応です","not-started");}
  // Bound the public Host response; do not forward raw subprocess errors or headers.
  const reader=response.body?.getReader();const reply:Uint8Array[]=[];let length=0;
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>256*1024){await reader.cancel();return fail(503,"フォルダ選択の結果を確認できません","unknown");}reply.push(value);}}finally{reader.releaseLock();}
  const resultBytes=new Uint8Array(length);offset=0;for(const chunk of reply){resultBytes.set(chunk,offset);offset+=chunk.byteLength;}
  const body=publicHostFolderBody(JSON.parse(new TextDecoder().decode(resultBytes)),response.status);
  return body?Response.json(body,{status:response.status,headers:{"cache-control":"no-store, private"}}):fail(503,"フォルダ選択の結果を確認できません","unknown");
 }catch{return fail(503,"フォルダ選択の結果を確認できません","unknown");}
}
