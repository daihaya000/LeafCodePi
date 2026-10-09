import { createBackendServer, listenBackend } from "./server.mjs";
import { readProviderLoginTransportDiagnostics } from "./provider-login-events.mjs";
import { pathToFileURL } from "node:url";
const runtime=await import(pathToFileURL(process.env.STREAM_PRODUCTION_BUNDLE).href);
runtime.getActiveProviderLogin();
let session,notify,signal,run,promptId,answered,producer,emitted=0;
if(process.env.STREAM_PROVIDER_EMPTY!=="1"){
 session=new runtime.ProviderLoginSession("fixture","oauth");globalThis.__leafcodePiHarness.loginSession=session;
 run=session.run({login:async(_p,_t,io)=>{
  notify=io.notify;signal=io.signal;
  notify({type:"auth_url",url:"https://example.test/login?redirect_uri=http://127.0.0.1:1456/oauth/callback&state=fixture-state"});
  const off=session.subscribe(event=>{if(event.type==="prompt"){promptId=event.id;off();}});
  answered=await io.prompt({type:"manual_code",message:"fixture prompt"});
 }});
}
const server=createBackendServer({token:process.env.LEAFCODE_PI_BACKEND_TOKEN,isReady:()=>true,taskFileStreamAction:runtime.openTaskFileStream,providerLoginEventsAction:runtime.openProviderLoginEvents});
const address=await listenBackend(server,0);
const sample=()=>({type:"sample",role:"backend",memory:process.memoryUsage(),state:{file:runtime.readTaskFileStreamDiagnostics(),provider:{...runtime.readProviderLoginStreamDiagnostics(),...readProviderLoginTransportDiagnostics(),...session?.readDiagnostics(),sid:session?.id??"",emitted,loginAborted:signal?.aborted??false,answered:answered!==undefined}}});
const timer=setInterval(()=>process.send?.(sample()),50);timer.unref();
process.on("message",async m=>{
 if(m?.type==="producer"){clearInterval(producer);if(m.interval){producer=setInterval(()=>{emitted++;notify?.({type:"progress",message:"日本語-"+emitted+"-"+"x".repeat(m.bytes??32700)});},m.interval);producer.unref();}}
 if(m?.type==="complete"){clearInterval(producer);session.answer(promptId,"isolated-fixture-code");await run;process.send?.(sample());}
 if(m==="sample")process.send?.(sample());
});
process.send?.({...sample(),type:"ready",port:address.port});
process.on("disconnect",()=>{clearInterval(timer);clearInterval(producer);session?.cancel();server.closeAllConnections();server.close();});
