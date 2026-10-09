import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Real build and process startup from a fixture that has no web directory at all. */
test("Backend builds and serves its runtime API without Web sources or Web packages", { timeout: 30_000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "leafcode-backend-independent-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill();
      await exited;
    }
    rmSync(fixture, { recursive: true, force: true });
  });
  const backend = join(fixture, "backend");
  mkdirSync(backend);
  for (const path of ["src", "core", "runtime-src", "types", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.runtime.json"]) {
    cpSync(join(ROOT, "backend", path), join(backend, path), { recursive: true });
  }
  // Only Backend-installed dependencies are available; no Web node_modules or root dependencies.
  symlinkSync(join(ROOT, "backend", "node_modules"), join(backend, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  cpSync(join(ROOT, "shared"), join(fixture, "shared"), { recursive: true });
  mkdirSync(join(fixture, "scripts"));
  cpSync(join(ROOT, "scripts", "build-backend-runtime.mjs"), join(fixture, "scripts", "build-backend-runtime.mjs"));
  for (const path of ["leafcode-subagents/src/api/background-work.ts", "leafcode-todowrite/visibility.ts"]) {
    const target = join(fixture, "extensions", path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, "extensions", path), target);
  }
  assert.equal(existsSync(join(fixture, "web")), false);
  const built = spawnSync(process.execPath, [join(fixture, "scripts", "build-backend-runtime.mjs"), "--force"], {
    cwd: fixture, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(built.status, 0, built.stderr || built.error?.message);
  assert.ok(existsSync(join(backend, "runtime", "runtime.bundle.mjs")));

  const data = join(fixture, "data"), agent = join(fixture, "agent");
  mkdirSync(data); mkdirSync(agent);
  // A fixture-only SDK command extension exercises durable Goal control without any model turn or tool execution.
  mkdirSync(join(agent,"extensions"));
  writeFileSync(join(agent,"extensions","goal-fixture.ts"),`
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function(api) {
  for (const action of ["start","pause","resume","stop","complete"]) {
    api.registerCommand("goal-"+action,{description:"Fixture state-only Goal command",handler:async(args,ctx)=>{
      const sessionId=ctx.sessionManager.getSessionId(),dir=join(process.env.LEAFCODE_PI_DATA_DIR,"goals-loop"),file=join(dir,sessionId+".json");
      let loop;try {loop=JSON.parse(readFileSync(file,"utf8"));}catch{}
      if(action==="start") {
        const input=JSON.parse(Buffer.from(args,"base64url").toString("utf8"));
        loop={id:"fixture-sdk-goal",sessionId,cwd:ctx.cwd,status:"queued",goal:input.goal,acceptance:input.acceptance,maxTurns:input.maxTurns,cooldownSeconds:input.cooldownSeconds,forceFullRun:input.forceFullRun,turnCount:0,nextTurnAt:null,progress:[{time:"fixture",status:"progress",summary:"fixture-authored",token:"PRIVATE-GOAL-TOKEN"}],token:"PRIVATE-GOAL-TOKEN",createdAt:"fixture-goal-stamp",updatedAt:"fixture-goal-stamp"};
      } else {
        if(!loop)throw Object.assign(new Error("Fixture Goal missing"),{status:404});
        loop.status=action==="pause"?"paused":action==="resume"?(loop.status==="completed"?"completed":"queued"):action==="stop"?"stopped":"completed";
        if(action==="resume"&&args.includes("--turns"))loop.maxTurns=Number(args.split("--turns ")[1].split(" ")[0]);
      }
      mkdirSync(dir,{recursive:true});writeFileSync(file,JSON.stringify(loop),"utf8");
    }});
  }
}
`,"utf8");
  // Fixture-only local SSE responder exercises the real SDK summarizer and abort without paid/external generation.
  let compactRequests=0,compactHoldEntered=false,compactHoldClosed=false,compactFocusSeen=false;
  const compactFocus="Fixture compaction authored 日本語",compactSummary="Fixture durable compaction summary 日本語";
  const compactProvider=createServer((req,res)=>{
    let text="";req.setEncoding("utf8");req.on("data",chunk=>{text+=chunk;});req.on("end",()=>{
      compactRequests++;compactFocusSeen ||= text.includes(compactFocus);
      if(text.includes("FIXTURE-HOLD-COMPACTION")){compactHoldEntered=true;res.on("close",()=>{compactHoldClosed=true;});return;}
      res.writeHead(200,{"content-type":"text/event-stream"});
      const packet=(choices,usage)=>({id:"fixture-summary",object:"chat.completion.chunk",created:1,model:"fixture-compactor",choices,...(usage?{usage}:{})});
      res.write("data: "+JSON.stringify(packet([{index:0,delta:{role:"assistant",content:compactSummary},finish_reason:null}]))+"\n\n");
      res.write("data: "+JSON.stringify(packet([{index:0,delta:{},finish_reason:"stop"}],{prompt_tokens:100,completion_tokens:10,total_tokens:110}))+"\n\n");res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(done=>compactProvider.listen(0,"127.0.0.1",done));
  t.after(async()=>{compactProvider.closeAllConnections();await new Promise(done=>compactProvider.close(done));});
  const compactBase=`http://127.0.0.1:${compactProvider.address().port}/v1`;
  // Independent direct-generation responder: fixed text only, no tools, no external provider.
  let helperRequests=0,helperHoldEntered=false,helperHoldClosed=false;
  const helperTitle="Fixture generated title 日本語",helperAnswer="Fixture assistance response 日本語";
  const helperProvider=createServer((req,res)=>{
    let raw="";req.setEncoding("utf8");req.on("data",chunk=>{raw+=chunk;});req.on("end",()=>{
      helperRequests++;const input=JSON.parse(raw);assert.ok(!input.tools?.length);
      if(raw.includes("FIXTURE-HOLD-PROGRESS")){helperHoldEntered=true;res.on("close",()=>{helperHoldClosed=true;});return;}
      const system=input.messages.find(message=>message.role==="system")?.content ?? "";
      const content=system.includes("タイトル")?helperTitle:helperAnswer;
      res.writeHead(200,{"content-type":"text/event-stream"});
      const packet=(delta,finish,usage)=>({id:"fixture-helper",object:"chat.completion.chunk",created:1,model:"fixture-helper",choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})});
      res.write("data: "+JSON.stringify(packet({role:"assistant",content},null))+"\n\n");
      res.write("data: "+JSON.stringify(packet({},"stop",{prompt_tokens:100,completion_tokens:10,total_tokens:110}))+"\n\n");res.end("data: [DONE]\n\n");
    });
  });
  await new Promise(done=>helperProvider.listen(0,"127.0.0.1",done));
  t.after(async()=>{helperProvider.closeAllConnections();await new Promise(done=>helperProvider.close(done));});
  let botRequests=0,botHoldEntered=false,botHoldClosed=false;const botAnswer="Fixture Bot response 日本語";
  const botServer=createServer((request,response)=>{let raw="";request.setEncoding("utf8");request.on("data",chunk=>{raw+=chunk;});request.on("end",()=>{
    const input=JSON.parse(raw);botRequests++;assert.ok(Array.isArray(input.messages));
    // SDK may advertise built-in tools even with tools:[]; this responder emits text only, never tool calls.
    response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"});response.flushHeaders();
    if(JSON.stringify(input.messages.findLast(message=>message.role==="user")).includes("FIXTURE-HOLD-BOT")){botHoldEntered=true;response.on("close",()=>{botHoldClosed=true;});return;}
    const chunk={id:"fixture-bot",object:"chat.completion.chunk",created:1,model:"fixture-bot",choices:[{index:0,delta:{role:"assistant",content:botAnswer},finish_reason:null}]};response.write("data: "+JSON.stringify(chunk)+"\n\n");response.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})+"\n\n");response.end("data: [DONE]\n\n");
  });});await new Promise(resolve=>botServer.listen(0,"127.0.0.1",resolve));t.after(async()=>{botServer.closeAllConnections();await new Promise(resolve=>botServer.close(resolve));});
  const helperBase=`http://127.0.0.1:${helperProvider.address().port}/v1`;
  writeFileSync(join(agent,"settings.json"),JSON.stringify({compaction:{keepRecentTokens:256},packages:[]}));
  // Ordinary prompt still targets the unreachable endpoint. Only explicit compaction uses the local responder.
  writeFileSync(join(agent,"models.json"),JSON.stringify({providers:{"fixture-bot":{api:"openai-completions",baseUrl:`http://127.0.0.1:${botServer.address().port}/v1`,apiKey:"fixture-only-not-a-real-key",models:[{id:"fixture-bot",name:"Fixture Bot",reasoning:false,input:["text"],contextWindow:8192,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]},"fixture-local":{baseUrl:"http://127.0.0.1:9/v1",apiKey:"fixture-only-not-a-real-key",api:"openai-completions",models:[{id:"fixture-model",name:"Fixture",reasoning:true,input:["text"],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]},"fixture-helper":{baseUrl:helperBase,apiKey:"fixture-only-not-a-real-key",api:"openai-completions",models:[{id:"fixture-helper",name:"Fixture helper",reasoning:false,input:["text"],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]},"fixture-compactor":{baseUrl:compactBase,apiKey:"fixture-only-not-a-real-key",api:"openai-completions",models:[{id:"fixture-compactor",name:"Fixture compactor",reasoning:false,input:["text"],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  const individualSessionFile = join(fixture, "individual-session.jsonl");
  writeFileSync(individualSessionFile, [JSON.stringify({ type: "session", version: 3, id: "isolated-session", cwd: fixture, timestamp: new Date().toISOString() }), ...Array.from({ length: 205 }, (_, i) => JSON.stringify({ type: "message", id: `ui${i}`, parentId: i ? `ui${i-1}` : null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `isolated line ${i}` }], timestamp: i } }))].join("\n") + "\n", "utf8");
  const compactSessionFile=join(fixture,"fixture-compaction-session.jsonl");
  writeFileSync(compactSessionFile,[{type:"session",version:3,id:"fixture-compaction-session",cwd:fixture,timestamp:new Date().toISOString()},...Array.from({length:32},(_,i)=>({type:"message",id:`compact-${i}`,parentId:i?`compact-${i-1}`:null,timestamp:new Date().toISOString(),message:i%2?{role:"assistant",content:[{type:"text",text:"Fixture history decision ".repeat(100)}],api:"openai-completions",provider:"fixture-compactor",model:"fixture-compactor",usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:i}:{role:"user",content:"Fixture history goal ".repeat(100),timestamp:i}}))].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const promotionSource = join(fixture,"workspaces","session-promotion-source"), promotionDestination = join(fixture,"session-promoted");
  mkdirSync(promotionSource,{recursive:true});writeFileSync(join(promotionSource,"keep-promotion.txt"),"fixture workspace 日本語");
  const promotionSessionFile=join(promotionSource,"promotion-session.jsonl");
  writeFileSync(promotionSessionFile,[{type:"session",version:3,id:"promotion-session",cwd:promotionSource,timestamp:new Date().toISOString()},{type:"message",id:"promotion-input",parentId:null,timestamp:new Date().toISOString(),message:{role:"user",content:"promotion authored text",timestamp:1}}].map(row=>JSON.stringify(row)).join("\n")+"\n");
  writeFileSync(join(data, "store.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture-project", name: "Fixture", rootPath: join(fixture, "workspaces"), archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], tasks: [{id:"compaction-task",projectId:"fixture-project",projectName:"Fixture",title:"Fixture compaction",directory:fixture,isolation:"current_folder",status:"idle",sessionId:"fixture-compaction-session",sessionFile:compactSessionFile,providerID:"fixture-compactor",modelID:"fixture-compactor",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}, {id:"session-promotion-task",projectId:null,projectName:"",title:"Fixture promotion",directory:promotionSource,isolation:"current_folder",status:"idle",sessionId:"promotion-session",sessionFile:promotionSessionFile,providerID:"fixture-local",modelID:"fixture-model",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}, {
    id: "independent-task", projectId: null, projectName: "test", title: "Backend-owned task", directory: fixture,
    isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: new Date().toISOString(),
  }, { id: "task-collection-archived", projectId: null, projectName: "test", title: "Isolated bulk target", directory: fixture, isolation: "current_folder", status: "archived", sessionId: null, sessionFile: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() }, { id: "individual-task", projectId: "fixture-project", projectName: "Fixture", title: "Isolated archived transcript", directory: fixture, isolation: "current_folder", status: "archived", sessionId: null, sessionFile: individualSessionFile, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
  // Fixture-only Bot targets the unreachable localhost model; no real identity/credentials or tool execution.
  const supervisorBotId="11111111-0123-4321-abcd-eeeeeeeeeeee",supervisorRoot=join(data,"bots",supervisorBotId),supervisorWorkspace=join(supervisorRoot,"workspace");
  mkdirSync(supervisorWorkspace,{recursive:true});writeFileSync(join(supervisorRoot,"config.json"),JSON.stringify({id:supervisorBotId,name:"Fixture supervisor",label:"Fixture",model:"fixture-local::fixture-model",enabled:true,permissionMode:"ask",tools:[],intercomEnabled:false,notificationsEnabled:false,codeAutoApprove:false,createdAt:"fixture",updatedAt:"fixture"}));
  const seededStore=JSON.parse(readFileSync(join(data,"store.json"),"utf8"));seededStore.tasks.push({id:"bot:"+supervisorBotId,kind:"bot",botId:supervisorBotId,projectId:null,projectName:"",title:"Fixture supervisor",directory:supervisorWorkspace,isolation:"current_folder",status:"idle",sessionId:null,sessionFile:null,providerID:"fixture-local",modelID:"fixture-model",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});writeFileSync(join(data,"store.json"),JSON.stringify(seededStore));
  writeFileSync(join(supervisorRoot,"SOUL.md"),"# Fixture supervisor\n");
  // Dedicated cold lifecycle teardown targets; no provider/child/tool execution.
  const lifecycleDeleteBotId="22222222-0123-4321-abcd-eeeeeeeeeeee", lifecycleDeleteRoot=join(data,"bots",lifecycleDeleteBotId), lifecycleRoomId="33333333-0123-4321-abcd-eeeeeeeeeeee", lifecycleRoomRoot=join(data,"bots","rooms");
  mkdirSync(join(lifecycleDeleteRoot,"workspace"),{recursive:true});writeFileSync(join(lifecycleDeleteRoot,"SOUL.md"),"# Fixture lifecycle delete\n");
  writeFileSync(join(lifecycleDeleteRoot,"config.json"),JSON.stringify({id:lifecycleDeleteBotId,name:"Fixture delete",label:"",model:"fixture-local::fixture-model",enabled:false,permissionMode:"ask",tools:[],codeAutoApprove:false,codeSessionTaskId:"lifecycle-code",createdAt:"fixture",updatedAt:"fixture"}));
  mkdirSync(lifecycleRoomRoot,{recursive:true});writeFileSync(join(lifecycleRoomRoot,lifecycleRoomId+".json"),JSON.stringify({id:lifecycleRoomId,name:"Fixture retained Room",members:[lifecycleDeleteBotId,supervisorBotId],botRelayEnabled:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:"kept-room-message",role:"user",text:"Retain authored Room 日本語",createdAt:1}]}));
  const lifecycleWorkspace=join(fixture,"lifecycle-code-workspace");mkdirSync(lifecycleWorkspace);writeFileSync(join(lifecycleWorkspace,"keep.txt"),"keep lifecycle workspace");
  const lifecycleSeed=JSON.parse(readFileSync(join(data,"store.json"),"utf8"));
  for(const [id,kind,botId,supervisorBotId] of [["bot:"+lifecycleDeleteBotId,"bot",lifecycleDeleteBotId,null],["lifecycle-code","code",lifecycleDeleteBotId,null],["lifecycle-supervised","code",null,lifecycleDeleteBotId]])lifecycleSeed.tasks.push({id,kind,botId,supervisorBotId,projectId:null,projectName:"",title:"Lifecycle teardown fixture",directory:id.startsWith("bot:")?join(lifecycleDeleteRoot,"workspace"):lifecycleWorkspace,isolation:"current_folder",status:"idle",sessionId:null,sessionFile:null,providerID:"fixture-local",modelID:"fixture-model",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  writeFileSync(join(data,"store.json"),JSON.stringify(lifecycleSeed));
  const conversationBotId="44444444-0123-4321-abcd-eeeeeeeeeeee",conversationBotTaskId="bot:"+conversationBotId,conversationSessionId="fixture-bot-conversation",conversationRoomId="55555555-0123-4321-abcd-eeeeeeeeeeee",conversationRoomTaskId="bot:"+conversationBotId+":room:"+conversationRoomId;
  const conversationBotDir=join(data,"bots",conversationBotId),conversationWorkspace=join(conversationBotDir,"workspace"),conversationSessionFile=join(fixture,"bot-conversation.jsonl"),created=Date.now(),createdIso=new Date(created).toISOString();mkdirSync(conversationWorkspace,{recursive:true});
  writeFileSync(join(conversationBotDir,"config.json"),JSON.stringify({id:conversationBotId,name:"Fixture conversation Bot",label:"Fixture",enabled:true,model:"fixture-bot::fixture-bot",permissionMode:"ask",tools:[],skills:[],thinkingLevel:"off",intercomEnabled:false,notificationsEnabled:false,codeAutoApprove:false,createdAt:createdIso,updatedAt:createdIso}));
  writeFileSync(join(conversationBotDir,"SOUL.md"),"Fixture conversation identity 日本語\n");
  writeFileSync(conversationSessionFile,[
    {type:"session",version:3,id:conversationSessionId,timestamp:createdIso,cwd:conversationWorkspace},
    {type:"message",id:"bot-input",parentId:null,timestamp:createdIso,message:{role:"user",content:[{type:"text",text:"Fixture Bot initial draft 日本語"}],timestamp:created}},
    {type:"message",id:"bot-answer",parentId:"bot-input",timestamp:createdIso,message:{role:"assistant",content:[{type:"text",text:"Fixture Bot initial response"}],api:"openai-completions",provider:"fixture-bot",model:"fixture-bot",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:created+1}}
  ].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const conversationRoom={id:conversationRoomId,name:"Fixture conversation room",members:[conversationBotId],cwd:conversationWorkspace,botRelayEnabled:false,messages:[{id:"room-user",role:"user",text:"Room context remains",mentions:[conversationBotId],createdAt:created,participantIds:[conversationBotId]},{id:"room-response",role:"assistant",botId:conversationBotId,requestId:"room-user",text:"Room pending context",status:"working",createdAt:created+1}],createdAt:createdIso,updatedAt:createdIso};writeFileSync(join(lifecycleRoomRoot,conversationRoomId+".json"),JSON.stringify(conversationRoom));
  const conversationSeed=JSON.parse(readFileSync(join(data,"store.json"),"utf8"));for(const id of [conversationBotTaskId,conversationRoomTaskId])conversationSeed.tasks.push({id,title:"Fixture conversation",directory:conversationWorkspace,isolation:"current_folder",kind:"bot",botId:conversationBotId,projectId:null,projectName:"",sessionId:id===conversationBotTaskId?conversationSessionId:null,sessionFile:id===conversationBotTaskId?conversationSessionFile:null,status:"idle",providerID:"fixture-bot",modelID:"fixture-bot",createdAt:createdIso,updatedAt:createdIso});writeFileSync(join(data,"store.json"),JSON.stringify(conversationSeed));
  const childArtifacts=join(fixture,"subagent-artifacts");mkdirSync(childArtifacts);
  const childTranscript=join(childArtifacts,"fixture-child_coder_transcript.jsonl");
  writeFileSync(childTranscript,[{recordType:"message",runId:"fixture-child",agent:"coder",childIndex:0,ts:1,message:{role:"user",content:"Fixture child authored 日本語"}},{recordType:"message",runId:"fixture-child",agent:"coder",ts:2,role:"assistant",message:{role:"assistant",content:[{type:"thinking",thinking:"Fixture child thinking"},{type:"text",text:"Fixture child answer"}],model:"fixture-local",provider:"fixture-local",timestamp:2}},{recordType:"tool_start",runId:"fixture-child",agent:"coder",ts:3,toolName:"read",toolCallId:"c"}].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const token = randomBytes(32).toString("hex");
  const launchOptions = {
    cwd: fixture, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: agent,
      LEAFCODE_PI_DATA_DIR: data, LEAFCODE_PI_DEFAULT_DIR: join(fixture, "workspaces"), APPDATA: join(fixture, "roaming"),
      LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_RUNTIME: "1",
      LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_MCP_NATIVE: "", LEAFCODE_PI_PROCESS_ROLE: "backend",
      LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: join(backend, "runtime", "runtime.bundle.mjs"),
      LEAFCODE_PI_PUSHOVER_TOKEN: "", LEAFCODE_PI_PUSHOVER_USER: "", LEAFCODE_PI_WEBUI_AUTH: "required" },
  };
  const launch = () => spawn(process.execPath, [join(backend, "src", "entry.mjs")], launchOptions);
  child = launch();
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 12_000;
  let listening;
  while (!listening && Date.now() < deadline && child.exitCode === null) {
    for (const line of stdout.split(/\r?\n/)) {
      try { const record = JSON.parse(line); if (record.type === "backend_listening") listening = record; } catch { /* incomplete output */ }
    }
    if (!listening) await delay(25);
  }
  assert.ok(listening, stderr || "Backend did not listen");
  const base = `http://127.0.0.1:${listening.port}`;
  const headers = { authorization: `Bearer ${token}`, "x-leafcode-backend-protocol": "1" };
  let health;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/internal/health`, { headers, signal: AbortSignal.timeout(3_000) });
      health = await response.json();
      if (response.status === 200 && health.ready) break;
    } catch (error) {
      if (error.name !== "TimeoutError" && error.name !== "AbortError") throw error;
    }
    await delay(50);
  }
  assert.equal(health?.ready, true, `${stderr} readiness=${JSON.stringify(health)}`);
  const response = await fetch(`${base}/internal/tasks`, { headers, signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.tasks.find((task) => task.id === "independent-task")?.title, "Backend-owned task");
  assert.equal((await fetch(`${base}/internal/tasks`, { signal: AbortSignal.timeout(2_000) })).status, 401);

  const configHeaders = { ...headers, "content-type": "application/json", "x-leafcode-configuration-origin": "http://localhost",
    "x-leafcode-configuration-host": "localhost", "x-leafcode-configuration-authorized": "1",
    "x-leafcode-configuration-operation": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  const saved = await fetch(`${base}/internal/configuration/settings/history-page-size`, {
    method: "PUT", headers: configHeaders, body: JSON.stringify({ value: "100" }), signal: AbortSignal.timeout(3_000),
  });
  const committed = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(committed));
  assert.equal(committed.mutation.saved, true); assert.equal(committed.mutation.saveStatus, "complete");
  assert.ok(committed.mutation.revision);
  const savedPath = join(data, "web-settings.json");
  assert.equal(JSON.parse(readFileSync(savedPath, "utf8"))["history-page-size"], "100");

  // Real Git business owner: fixture-only commands/files, no Next sources or fallback.
  const workspace = join(fixture, "workspaces"); mkdirSync(workspace,{recursive:true});
  const businessHeaders = { ...headers, "content-type": "application/json", "x-leafcode-business-origin": "http://localhost",
    "x-leafcode-business-host": "localhost", "x-leafcode-business-authorized": "1" };
  const business = async (route, body, query = "", extraHeaders = {}, method = "POST") => {
    const reply = await fetch(`${base}/internal/json-business/${route}${query}`, { headers: { ...businessHeaders, ...extraHeaders },
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    assert.equal(reply.status, 200); return reply.json();
  };
  // Real Bot lifecycle owner: create/template/defaults, cold tools, config update and full teardown.
  const lifecycleCreateId="10101010-0123-4321-abcd-eeeeeeeeeeee", lifecyclePatchId="20202020-0123-4321-abcd-eeeeeeeeeeee", lifecycleDeleteId="30303030-0123-4321-abcd-eeeeeeeeeeee";
  const lifecycleCreated=await business("bots",{name:"Fixture lifecycle 日本語",templateId:"researcher",model:"FORGED",permissionMode:"allow",codeAutoApprove:false},"",{"x-leafcode-business-operation":lifecycleCreateId});
  assert.equal(lifecycleCreated.status,201,JSON.stringify(lifecycleCreated));const lifecycleBot=lifecycleCreated.body.bot;
  assert.equal(lifecycleBot.name,"Fixture lifecycle 日本語");assert.equal(lifecycleBot.label,"調査アシスタント");assert.match(lifecycleBot.soul,/調査を支援/);assert.equal(lifecycleBot.model,null);assert.equal(lifecycleBot.permissionMode,"ask");assert.equal(lifecycleBot.thinkingLevel,"off");assert.equal(lifecycleBot.codeAutoApprove,true);
  const lifecycleBotList=await business("bots",undefined);assert.ok(lifecycleBotList.body.bots.some(bot=>bot.id===lifecycleBot.id&&bot.codeSessionCount===0));
  assert.equal((await business("bots",undefined,"",{"if-none-match":lifecycleBotList.headers.etag})).status,304);
  assert.equal((await business("bots/"+lifecycleBot.id,undefined)).body.bot.name,lifecycleBot.name);
  const lifecycleCold=JSON.parse(readFileSync(join(data,"store.json"),"utf8")).tasks.find(task=>task.id==="bot:"+lifecycleBot.id);assert.equal(lifecycleCold.sessionFile,null);
  const lifecyclePatched=await business("bots/"+lifecycleBot.id,{name:"Fixture renamed 日本語",label:"Fixture label",tools:["read"],skills:{mode:"include",include:["fixture-skill"],exclude:[]},notificationsEnabled:false,intercomEnabled:false,extraRoots:[lifecycleWorkspace]},"",{"x-leafcode-business-operation":lifecyclePatchId},"PATCH");
  assert.equal(lifecyclePatched.status,200,JSON.stringify(lifecyclePatched));assert.equal(lifecyclePatched.body.bot.name,"Fixture renamed 日本語");assert.deepEqual(lifecyclePatched.body.bot.tools,["read"]);assert.equal(lifecyclePatched.body.operation.execution,"complete");
  const lifecycleDeleted=await business("bots/"+lifecycleDeleteBotId,{},"",{"x-leafcode-business-operation":lifecycleDeleteId},"DELETE");assert.equal(lifecycleDeleted.status,200,JSON.stringify(lifecycleDeleted));assert.equal(lifecycleDeleted.body.ok,true);assert.equal(existsSync(lifecycleDeleteRoot),false);
  const lifecycleRemaining=JSON.parse(readFileSync(join(data,"store.json"),"utf8")).tasks;assert.ok(!lifecycleRemaining.some(task=>task.botId===lifecycleDeleteBotId));assert.equal(lifecycleRemaining.find(task=>task.id==="lifecycle-supervised").supervisorBotId,null);
  const lifecycleRoom=JSON.parse(readFileSync(join(lifecycleRoomRoot,lifecycleRoomId+".json"),"utf8"));assert.deepEqual(lifecycleRoom.members,[supervisorBotId]);assert.ok(JSON.stringify(lifecycleRoom.messages).includes("Retain authored Room 日本語"));assert.equal(readFileSync(join(lifecycleWorkspace,"keep.txt"),"utf8"),"keep lifecycle workspace");
  const lifecycleLedger=readFileSync(join(data,"bot-lifecycle-command.json"),"utf8");for(const text of ["Fixture",lifecycleBot.id,lifecycleDeleteBotId,"fixture-skill","FORGED"])assert.ok(!lifecycleLedger.includes(text));
  assert.equal((await business("git/init", { directory: workspace })).body.ok, true);
  writeFileSync(join(workspace, "README.md"), "Owner-only fixture\n");
  const committedGit = await business("git/commit", { directory: workspace, paths: ["README.md"], message: "独立API検証" });
  assert.equal(committedGit.status, 200, JSON.stringify(committedGit)); assert.equal(committedGit.body.ok, true);
  const query = `?directory=${encodeURIComponent(workspace)}`;
  const history = await business("git/log", undefined, query);
  assert.equal(history.body.commits.length, 1); assert.match(history.body.commits[0].subject, /独立API検証/);
  const conditional = await business("git/log", undefined, query, { "if-none-match": history.headers.etag });
  assert.equal(conditional.status, 304); assert.equal(conditional.body, null);
  const branches = await business("git/branches", undefined, query); assert.equal(branches.status, 200);
  const shown = await business("git/show", undefined, `${query}&commit=${history.body.commits[0].hash}`);
  assert.equal(shown.body.files[0].path, "README.md");
  writeFileSync(join(workspace, "README.md"), "Owner-only fixture\nchanged\n");
  const diff = await business("diff/files", undefined, query);
  assert.equal(diff.body.git, true); assert.ok(diff.body.files.some(file => file.path === "README.md"));
  const suggestion = await business("git/commit-message", { directory: workspace, files: [{ path: "README.md", additions: 1, deletions: 0 }] });
  assert.equal(suggestion.body.source, "fallback"); assert.ok(suggestion.body.message);
  const unsafe = await business("git/merge", { directory: workspace, branch: "--help" }); assert.equal(unsafe.status, 400);
  const outside = await business("git/branches", undefined, "?directory=" + encodeURIComponent(process.platform === "win32" ? "C:\\Windows" : "/etc"));
  assert.equal(outside.status, 403);
  // Workspace file selection and suggestion validation run entirely in this owner.
  const workspaceListing = await business("projects/fixture-project/files", undefined); assert.equal(workspaceListing.status, 200); assert.ok(workspaceListing.body.entries.some(entry => entry.name === "README.md"));
  const workspaceFile = await business("projects/fixture-project/files", undefined, "?path=README.md&read=1"); assert.equal(workspaceFile.status, 200); assert.equal(Buffer.from(workspaceFile.body.data, "base64").toString("utf8"), "Owner-only fixture\nchanged\n");
  const taskFile = await business("tasks/independent-task/files", undefined, "?path=workspaces%2FREADME.md&read=1"); assert.equal(taskFile.status, 200); assert.equal(taskFile.body.data, workspaceFile.body.data);
  const workspaceEscape = await business("projects/fixture-project/files", undefined, "?path=..%2Fdata%2Fstore.json&read=1"); assert.equal(workspaceEscape.status, 400);
  const workspaceId = await business("projects/fixture%252Fproject/files", undefined); assert.equal(workspaceId.status, 400);
  writeFileSync(join(workspace, "invalid.txt"), Buffer.from([0xff, 0xfe])); assert.equal((await business("projects/fixture-project/files", undefined, "?path=invalid.txt&read=1")).status, 415);
  const refusedSuggestion = await business("projects/fixture-project/next-task", {}); assert.equal(refusedSuggestion.status, 400); assert.equal(refusedSuggestion.body.mutation, undefined); assert.equal(refusedSuggestion.body.operation, undefined);
  // Definition writes/reload/receipts happen in this same Web-free owner.
  const definitionOperation = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const definitionReply = await business("agents-md", { content: "Isolated owner 日本語" }, "", { "x-leafcode-business-operation": definitionOperation }, "PATCH");
  assert.equal(definitionReply.status, 200, JSON.stringify(definitionReply));
  assert.equal(definitionReply.body.mutation.saved, true); assert.equal(definitionReply.body.mutation.apply, "applied");
  assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), "Isolated owner 日本語");
  const createdAgent = await business("agents", { name: "isolated", systemPrompt: "Fixture persona" }, "", { "x-leafcode-business-operation": "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa" });
  assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent)); assert.equal(createdAgent.body.mutation.saved, true);
  const agentDraft = await business("agents/isolated", undefined); assert.equal(agentDraft.body.draft.systemPrompt, "Fixture persona");
  const illegalAgent = await business("agents/%2E%2E%2Fescape", { enabled: true }, "", { "x-leafcode-business-operation": "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb" }, "PATCH");
  assert.equal(illegalAgent.status, 400);
  assert.equal(existsSync(join(fixture, "escape.md")), false);
  const authOperation = "11111111-2222-3333-4444-555555555555";
  const refusedLogin = await business("providers/fixture/login", { type: "invalid" }, "", { "x-leafcode-business-operation": authOperation });
  assert.equal(refusedLogin.status, 400); assert.equal(refusedLogin.body.operation.execution, "complete");
  const loginEvents = await fetch(`${base}/internal/provider-login-events/fixture?sessionId=missing`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal(loginEvents.status, 200); assert.match(await loginEvents.text(), /event: done[\s\S]*"ok":false/);
  const endpointOperation = "eeeeeeee-ffff-aaaa-bbbb-cccccccccccc";
  const endpointReply = await business("providers/leafcodecloud/base-url", { baseUrl: "http://127.0.0.1:1/v1" }, "", { "x-leafcode-business-operation": endpointOperation }, "PUT");
  assert.equal(endpointReply.status, 200, JSON.stringify(endpointReply));
  assert.equal(endpointReply.body.mutation.saved, true); assert.equal(endpointReply.body.mutation.apply, "deferred");
  assert.equal((await business("providers/leafcodecloud/base-url")).body.baseUrl, "http://127.0.0.1:1/v1");
  const modelReply = await business("provider-models/fixture%3A%3Amodel", { contextWindow: 16384 }, "", { "x-leafcode-business-operation": "ffffffff-aaaa-bbbb-cccc-dddddddddddd" }, "PATCH");
  assert.equal(modelReply.status, 200, JSON.stringify(modelReply)); assert.equal(modelReply.body.mutation.saved, true);
  assert.equal(JSON.parse(readFileSync(join(data, "provider-model-state.json"), "utf8")).contextWindow["fixture::model"], 16384);
  // Account records and credentials are persisted by this same owner, not a Next or global-user fallback.
  const accountOperation = "22222222-3333-4444-5555-666666666666";
  const accountReply = await business("accounts", { label: "Isolated account", providers: ["openrouter"] }, "", { "x-leafcode-business-operation": accountOperation });
  assert.equal(accountReply.status, 200, JSON.stringify(accountReply)); assert.equal(accountReply.body.mutation.saved, true);
  const accountId = accountReply.body.account.id;
  const creditOperation = "33333333-4444-5555-6666-777777777777";
  const creditReply = await business(`accounts/${accountId}/openrouter-credits`, { managementKey: "PRIVATE-FIXTURE-KEY" }, "", { "x-leafcode-business-operation": creditOperation });
  assert.equal(creditReply.status, 200); assert.equal(creditReply.body.mutation.saved, true);
  assert.ok(!JSON.stringify(creditReply).includes("PRIVATE"));
  const creditPath = join(agent, "accounts", accountId, "openrouter.json");
  assert.equal(JSON.parse(readFileSync(creditPath, "utf8")).managementKey, "PRIVATE-FIXTURE-KEY");
  const accountStatus = await business(`accounts/${accountId}/auth-status`);
  assert.equal(accountStatus.body.openrouterManagementKeyConfigured, true); assert.ok(!JSON.stringify(accountStatus).includes("PRIVATE"));
  assert.ok(!readFileSync(join(data, "configuration-command.json"), "utf8").includes("PRIVATE"));
  const illegalAccount = await fetch(`${base}/internal/json-business/accounts/%2E%2E%2Fescape/openrouter-credits`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": "44444444-5555-6666-7777-888888888888" }, body: JSON.stringify({ managementKey: "PRIVATE-REFUSED" }), signal: AbortSignal.timeout(3000) });
  assert.equal(illegalAccount.status, 404); assert.equal(existsSync(join(agent, "escape")), false);
  // Native usage feature: real catalog save/read and admission rejection; never redeem a real external credit.
  const usageCatalog = await business("codexbar/providers", undefined);
  assert.equal(usageCatalog.status, 200); assert.ok(Array.isArray(usageCatalog.body.providers));
  const usageConfigOperation = "55555555-6666-7777-8888-999999999999";
  const usageConfig = await business("codexbar/providers", { providerId: "cursor", enabled: false, version: usageCatalog.body.version }, "", { "x-leafcode-business-operation": usageConfigOperation }, "PUT");
  assert.equal(usageConfig.status, 200, JSON.stringify(usageConfig)); assert.equal(usageConfig.body.mutation.saved, true);
  assert.equal(JSON.parse(readFileSync(join(fixture, "roaming", "CodexBar", "config.json"), "utf8")).enabledProviders.includes("cursor"), false);
  assert.equal((await business("codexbar/usage", undefined, "?scope=invalid")).status, 400);
  assert.equal((await business("codexbar/reset-credits", undefined, "?accountId=missing")).status, 404);
  const usageOperation = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const rejectedConsume = await business("codexbar/reset-credits", { creditId: "" }, "", { "x-leafcode-business-operation": usageOperation });
  assert.equal(rejectedConsume.status, 400); assert.equal(rejectedConsume.body.operation.execution, "complete"); assert.equal(rejectedConsume.body.mutation, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(data, "usage-command.json"), "utf8")).operations, [{ id: usageOperation, execution: "complete" }]);
  // Real Peer owner: create/revoke tokens and lease only this fixture's named-account API key.
  writeFileSync(join(agent, "accounts", accountId, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "PEER-FIXTURE-LEASE", refresh: "PRIVATE-NEVER-EXPORT" } }));
  const peerOperation = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const peerGrantReply = await business("peer-auth/peers", { label: "Fixture peer", providers: ["openrouter"] }, "", { "x-leafcode-business-operation": peerOperation });
  assert.equal(peerGrantReply.status, 201); assert.equal(peerGrantReply.body.mutation.saved, true);
  const peerToken = peerGrantReply.body.token; assert.ok(peerToken); assert.ok(!readFileSync(join(data, "peer-auth.json"), "utf8").includes(peerToken));
  const peerEnabled = await business("peer-auth/peers", { enabled: true }, "", { "x-leafcode-business-operation": "88888888-9999-aaaa-bbbb-cccccccccccc" }, "PATCH"); assert.equal(peerEnabled.status, 200);
  const peerHeaders = { ...businessHeaders, "x-leafcode-business-authorized": "0", "x-leafcode-business-peer-authorization": `Bearer ${peerToken}` };
  const peerRequest = async (origin, route, body) => { const response = await fetch(`${origin}/internal/json-business/${route}`, { headers: peerHeaders, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200); return response.json(); };
  const peerList = await peerRequest(base, "peer-auth/list"); assert.equal(peerList.status, 200); assert.equal(peerList.body.accounts[0].accountId, accountId); assert.ok(!JSON.stringify(peerList).includes("PEER-FIXTURE-LEASE"));
  const peerLease = await peerRequest(base, "peer-auth/resolve", { providerId: "openrouter", accountId }); assert.equal(peerLease.status, 200); assert.deepEqual(peerLease.body, { credential: { type: "api_key", key: "PEER-FIXTURE-LEASE" } });
  assert.equal((await peerRequest(base, "peer-auth/resolve", { providerId: "openrouter" })).status, 403);
  const unauthImport = await fetch(`${base}/internal/json-business/peer-auth/import`, { headers: peerHeaders, signal: AbortSignal.timeout(3000) }); assert.equal(unauthImport.status, 403);
  // Full Project lifecycle in this Web-free owner; move only this isolated workspace.
  const lifecycleSource = join(fixture, "lifecycle-source"), lifecycleDestination = join(fixture, "lifecycle-destination"); mkdirSync(lifecycleSource); writeFileSync(join(lifecycleSource, "keep.txt"), "Project owner fixture\n");
  const projectOperation = "abababab-bbbb-cccc-dddd-eeeeeeeeeeee";
  const projectCreated = await business("projects", { rootPath: lifecycleSource }, "", { "x-leafcode-business-operation": projectOperation }); assert.equal(projectCreated.status, 200); assert.equal(projectCreated.body.operation.execution, "complete"); const lifecycleId = projectCreated.body.project.id;
  const projectIcon = await business("projects", { id: lifecycleId, icon: "data:image/png;base64,YQ==" }, "", { "x-leafcode-business-operation": "bcbcbcbc-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectIcon.status, 200);
  const projectMoved = await business("projects", { id: lifecycleId, destinationPath: lifecycleDestination }, "", { "x-leafcode-business-operation": "cdcdcdcd-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectMoved.status, 200); assert.equal(readFileSync(join(lifecycleDestination, "keep.txt"), "utf8"), "Project owner fixture\n"); assert.equal(existsSync(lifecycleSource), false);
  const projectArchived = await business("projects", { id: lifecycleId, archived: true }, "", { "x-leafcode-business-operation": "dededede-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectArchived.body.project.archived, true);
  const projectRestored = await business("projects", { id: lifecycleId, archived: false }, "", { "x-leafcode-business-operation": "efefefef-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectRestored.body.project.archived, false);
  const projectList = await business("projects", undefined, "?archived=1"); assert.match(projectList.body.projects.find(project => project.id === lifecycleId).icon, /\/api\/projects\/.+\/icon\?v=/); assert.ok(!readFileSync(join(data, "project-command.json"), "utf8").includes(lifecycleSource));
  // Task collection owner: real metadata/maintenance/teardown; never invoke a paid generation.
  const taskRows = await business("tasks", undefined, "?titles=1&archived=1&kind=all"); assert.equal(taskRows.status, 200); assert.ok(taskRows.body.tasks.some(task => task.id === "task-collection-archived")); assert.ok(taskRows.body.tasks.some(task => task.id === "independent-task" && task.status === "idle"));
  const taskPane = await business("tasks", undefined, "?paneCandidates=1"); assert.ok(taskPane.body.tasks.some(task => task.id === "independent-task")); assert.ok(!("sessionFile" in taskPane.body.tasks[0]));
  const taskAttention = await business("tasks", undefined, "?attention=1"); assert.deepEqual(taskAttention.body.attention, []);
  const taskCreateId = "acacacac-bbbb-cccc-dddd-eeeeeeeeeeee";
  const refusedTask = await business("tasks", { projectId: "missing-fixture-project", prompt: "no paid generation" }, "", { "x-leafcode-business-operation": taskCreateId }); assert.equal(refusedTask.status, 404); assert.equal(refusedTask.body.operation.execution, "complete");
  const taskBulkId = "bdbdbdbd-bbbb-cccc-dddd-eeeeeeeeeeee";
  const taskBulk = await fetch(`${base}/internal/json-business/tasks?noProject=1`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": taskBulkId }, signal: AbortSignal.timeout(5000) }); const taskRemoved = await taskBulk.json(); assert.equal(taskRemoved.body.removed, 1); assert.equal(taskRemoved.body.operation.execution, "complete");
  assert.ok(!readFileSync(join(data, "task-collection-command.json"), "utf8").includes("no paid generation"));
  const individualFull = await business("tasks/individual-task", undefined); assert.equal(individualFull.status, 200); assert.equal(individualFull.body.task.messages.length, 205); assert.equal(individualFull.body.task.isStreaming, false);
  const individualPage = await business("tasks/individual-task", undefined, "?messages=page"); assert.equal(individualPage.body.task.messages.length, 100); assert.equal(individualPage.body.task.messageHistory.hasMore, true);
  const individualOmit = await business("tasks/individual-task", undefined, "?messages=omit"); assert.deepEqual(individualOmit.body.task.messages, []);
  const historyNewest = await business("tasks/individual-task/messages", undefined); assert.equal(historyNewest.status, 200); assert.equal(historyNewest.body.messages.length, 100); assert.equal(historyNewest.body.messageHistory.nextCursor, "ui105");
  const historyOlder = await business("tasks/individual-task/messages", undefined, "?before=ui105"); assert.equal(historyOlder.body.messages.length, 100); assert.equal(historyOlder.body.messages.at(-1).id, "ui104");
  assert.equal((await business("tasks/individual-task/messages", undefined, "?before=missing")).status, 409);
  const historySearch = await business("tasks/individual-task/search", undefined, "?q=isolated&limit=2"); assert.equal(historySearch.body.total, 205); assert.deepEqual(historySearch.body.hits.map(hit=>hit.messageId), ["ui203","ui204"]);
  const bookmarkId = "abababab-1234-4321-abcd-eeeeeeeeeeee";
  const bookmarked = await business("tasks/individual-task/bookmarks", {messageId:"ui0",role:"user",messageCreatedAt:0,preview:"isolated line 0"}, "", {"x-leafcode-business-operation":bookmarkId}, "PUT"); assert.equal(bookmarked.status,200); assert.equal(bookmarked.body.operation.execution,"complete");
  const verifiedBookmark = await business("tasks/individual-task/bookmarks", undefined, "?verify=1"); assert.deepEqual(verifiedBookmark.body.missing, []); assert.equal(verifiedBookmark.body.bookmarks.length,1);
  const taskSettingsModelId = "cccccccc-1234-4321-abcd-eeeeeeeeeeee";
  const settingsModel = await business("tasks/individual-task/model", {model:"fixture-local::fixture-model"}, "", {"x-leafcode-business-operation":taskSettingsModelId});
  assert.equal(settingsModel.status,200,JSON.stringify(settingsModel)); assert.equal(settingsModel.body.task.modelID,"fixture-model"); assert.equal(settingsModel.body.task.providerID,"fixture-local"); assert.equal(settingsModel.body.operation.execution,"complete");
  const autoLoopFile = join(data,"goals-loop","fixture-settings-session.json"); mkdirSync(join(data,"goals-loop"),{recursive:true});
  writeFileSync(autoLoopFile,JSON.stringify({sessionId:"fixture-settings-session",goal:"fixture only",status:"paused",pauseReason:"user",createdAt:"fixture-stamp"}));
  // Cold model selection creates no session; a fixture row binds the persisted Goal marker.
  const settingsStore = JSON.parse(readFileSync(join(data,"store.json"),"utf8")); settingsStore.tasks.find(task=>task.id==="individual-task").sessionId="fixture-settings-session"; writeFileSync(join(data,"store.json"),JSON.stringify(settingsStore));
  const taskSettingsAutoId = "dddddddd-1234-4321-abcd-eeeeeeeeeeee";
  const settingsAuto = await business("tasks/individual-task/goal-loop-auto-model",{enabled:true},"",{"x-leafcode-business-operation":taskSettingsAutoId},"PUT"); assert.equal(settingsAuto.status,200,JSON.stringify(settingsAuto)); assert.equal(settingsAuto.body.enabled,true);
  assert.equal(JSON.parse(readFileSync(savedPath,"utf8"))["goal-loop-auto-model:individual-task"],"fixture-stamp");
  // No active Goal work is executed by this fixture; only the marker remains for restart verification.
  writeFileSync(autoLoopFile,JSON.stringify({sessionId:"fixture-settings-session",goal:"fixture only",status:"completed",createdAt:"fixture-stamp"}));
  const settingsAgent = await business("tasks/individual-task/agent",{agent:""},"",{"x-leafcode-business-operation":"eeeeeeee-1234-4321-abcd-eeeeeeeeeeee"}); assert.equal(settingsAgent.status,200); assert.equal(settingsAgent.body.task.agent??null,null);
  const invalidThinking = await business("tasks/individual-task/thinking",{thinkingLevel:"invalid"},"",{"x-leafcode-business-operation":"ffffffff-1234-4321-abcd-eeeeeeeeeeee"}); assert.equal(invalidThinking.status,400);
  const individualRestoreId = "cececece-bbbb-cccc-dddd-eeeeeeeeeeee";
  const individualRestore = await business("tasks/individual-task", { archived: false }, "", { "x-leafcode-business-operation": individualRestoreId }, "PATCH"); assert.equal(individualRestore.status, 200); assert.equal(individualRestore.body.task.status, "idle");
  const individualColdRead = await business("tasks/individual-task", undefined, "?messages=omit"); assert.equal(individualColdRead.status, 200); assert.equal(individualColdRead.body.task.status, "idle"); assert.deepEqual(individualColdRead.body.task.messages, []);
  const settingsThinking = await business("tasks/individual-task/thinking",{thinkingLevel:"high"},"",{"x-leafcode-business-operation":"bcbcbcbc-5678-4321-abcd-eeeeeeeeeeee"}); assert.equal(settingsThinking.status,200,JSON.stringify(settingsThinking)); assert.equal(settingsThinking.body.task.thinkingLevel,"high"); assert.equal(settingsThinking.body.operation.execution,"complete");
  const goalStartId="abababab-6789-4321-abcd-eeeeeeeeeeee",goalPath="tasks/individual-task/goal-loop",goalText="Fixture Goal authored 日本語";
  const goalStarted=await business(goalPath,{action:"start",goal:goalText,acceptance:"one\n two",maxTurns:2},"",{"x-leafcode-business-operation":goalStartId});
  assert.equal(goalStarted.status,200,JSON.stringify(goalStarted));assert.equal(goalStarted.body.loop.status,"queued");assert.equal(goalStarted.body.operation.execution,"complete");assert.ok(!JSON.stringify(goalStarted).includes("PRIVATE-GOAL-TOKEN"));
  const activeGoals=await business("goal-loop/active",undefined);assert.ok(activeGoals.body.taskIds.includes("individual-task"));
  const goalBeforeControl=await business(goalPath,undefined);assert.equal(goalBeforeControl.body.loop.goal,goalText);
  const goalControlIds=["bcbcbcbc-6789-4321-abcd-eeeeeeeeeeee","cdcdcdcd-6789-4321-abcd-eeeeeeeeeeee","dededede-6789-4321-abcd-eeeeeeeeeeee","efefefef-6789-4321-abcd-eeeeeeeeeeee"];
  for(const [i,action,status] of [[0,"pause","paused"],[1,"resume","queued"],[2,"complete","completed"],[3,"stop","stopped"]]) {
    const controlled=await business(goalPath,{action,maxTurns:7},"",{"x-leafcode-business-operation":goalControlIds[i]},"PATCH");assert.equal(controlled.status,200,JSON.stringify(controlled));assert.equal(controlled.body.loop.status,status);assert.equal(controlled.body.operation.execution,"complete");
  }
  assert.equal((await business("goal-loop/active",undefined)).body.taskIds.includes("individual-task"),false);
  assert.equal((await business(goalPath,{action:"start",goal:goalText},"",{"x-leafcode-business-operation":goalStartId})).status,409);
  const goalLedger=readFileSync(join(data,"task-goal-loop-command.json"),"utf8");assert.ok(!goalLedger.includes(goalText));assert.ok(!goalLedger.includes("PRIVATE-GOAL-TOKEN"));
  // Compaction start and abort are real concurrent HTTP/SDK operations. Cold abort must not hydrate a session.
  const compactColdAbortId="aaaaaaaa-8901-4321-abcd-eeeeeeeeeeee",compactCancelId="abababab-8901-4321-abcd-eeeeeeeeeeee",compactAbortId="bcbcbcbc-8901-4321-abcd-eeeeeeeeeeee",compactSuccessId="cdcdcdcd-8901-4321-abcd-eeeeeeeeeeee";
  const coldCompactAbort=await business("tasks/compaction-task/compact/abort",{},"",{"x-leafcode-business-operation":compactColdAbortId});assert.equal(coldCompactAbort.status,404);assert.equal(compactRequests,0);
  const compactCancelled=business("tasks/compaction-task/compact",{customInstructions:"FIXTURE-HOLD-COMPACTION"},"",{"x-leafcode-business-operation":compactCancelId});
  const compactWait=Date.now()+3000;while(!compactHoldEntered&&Date.now()<compactWait)await delay(10);assert.ok(compactHoldEntered,"Fixture summarizer was not entered");
  // Real SDK compaction hold makes this a busy user Code task; delegation/release must not interrupt it.
  const supervisorHandoffId="aaaaaaaa-2345-4321-abcd-eeeeeeeeeeee",supervisorReleaseId="abababab-2345-4321-abcd-eeeeeeeeeeee";
  const supervisorHandoff=await business("tasks/compaction-task/supervisor",{botId:supervisorBotId},"",{"x-leafcode-business-operation":supervisorHandoffId});assert.equal(supervisorHandoff.status,200,JSON.stringify(supervisorHandoff));assert.equal(supervisorHandoff.body.task.supervisorBotId,supervisorBotId);assert.equal(supervisorHandoff.body.operation.execution,"complete");
  const outboxPath=join(data,"bot-code-requests"),supervisionRequestFiles=readdirSync(outboxPath).filter(file=>file.endsWith(".json"));
  const supervisionRequests=supervisionRequestFiles.map(file=>JSON.parse(readFileSync(join(outboxPath,file),"utf8"))).filter(request=>request.codeTaskId==="compaction-task"&&request.supervision);assert.equal(supervisionRequests.length,1);assert.equal(supervisionRequests[0].state,"running");assert.ok(!compactHoldClosed);
  const supervisorRelease=await business("tasks/compaction-task/supervisor",{botId:null},"",{"x-leafcode-business-operation":supervisorReleaseId});assert.equal(supervisorRelease.status,200,JSON.stringify(supervisorRelease));assert.equal(supervisorRelease.body.task.supervisorBotId,null);assert.ok(!compactHoldClosed);assert.equal(JSON.parse(readFileSync(join(outboxPath,supervisionRequests[0].id+".json"),"utf8")).state,"cancelled");
  const supervisionLedger=readFileSync(join(data,"task-supervision-command.json"),"utf8");assert.ok(!supervisionLedger.includes(supervisorBotId));assert.ok(!supervisionLedger.includes("Fixture history"));
  const childRuns=await business("tasks/compaction-task/subagents",undefined);assert.equal(childRuns.status,200,JSON.stringify(childRuns));const childRun=childRuns.body.runs.find(run=>run.runId==="fixture-child");assert.ok(childRun);assert.equal(childRun.currentTool,"read");assert.ok(JSON.stringify(childRun.messages).includes("Fixture child authored 日本語"));assert.ok(JSON.stringify(childRun.messages).includes("Fixture child thinking"));assert.equal(childRun.truncated,false);
  const childFiltered=await business("tasks/compaction-task/subagents",undefined,"?since="+(Date.now()+60000));assert.deepEqual(childFiltered.body.runs,[]);
  assert.ok(!readFileSync(compactSessionFile,"utf8").includes("Fixture child authored"));
  const compactAborted=await business("tasks/compaction-task/compact/abort",{},"",{"x-leafcode-business-operation":compactAbortId});assert.equal(compactAborted.status,200,JSON.stringify(compactAborted));assert.equal(compactAborted.body.operation.execution,"complete");
  const cancelledCompaction=await compactCancelled;assert.equal(cancelledCompaction.status,400,JSON.stringify(cancelledCompaction));assert.equal(cancelledCompaction.body.operation.execution,"complete");
  const closeWait=Date.now()+1000;while(!compactHoldClosed&&Date.now()<closeWait)await delay(10);assert.ok(compactHoldClosed);assert.ok(!readFileSync(compactSessionFile,"utf8").includes('"type":"compaction"'));
  const compactCompleted=await business("tasks/compaction-task/compact",{customInstructions:compactFocus},"",{"x-leafcode-business-operation":compactSuccessId});assert.equal(compactCompleted.status,200,JSON.stringify(compactCompleted));assert.equal(compactCompleted.body.operation.execution,"complete");assert.equal(compactCompleted.body.task.isCompacting,false);assert.ok(JSON.stringify(compactCompleted.body.task.messages).includes(compactSummary));assert.ok(compactFocusSeen);assert.equal(compactRequests,2);
  const persistedCompaction=readFileSync(compactSessionFile,"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.type==="compaction");assert.equal(persistedCompaction.length,1);assert.equal(persistedCompaction[0].summary,compactSummary);
  const compactLedger=readFileSync(join(data,"task-compaction-command.json"),"utf8");assert.ok(!compactLedger.includes(compactFocus));assert.ok(!compactLedger.includes("FIXTURE-HOLD-COMPACTION"));
  const botHoldPromptId="11111111-3456-4321-abcd-eeeeeeeeeeee",botHoldAbortId="22222222-3456-4321-abcd-eeeeeeeeeeee",botPromptId="33333333-3456-4321-abcd-eeeeeeeeeeee",botRevertId="44444444-3456-4321-abcd-eeeeeeeeeeee",botDurableId="55555555-3456-4321-abcd-eeeeeeeeeeee",botGoalId="66666666-3456-4321-abcd-eeeeeeeeeeee",botGoalAbortId="77777777-3456-4321-abcd-eeeeeeeeeeee";
  const botConversationPath="bots/"+conversationBotId,botTaskPath="tasks/"+encodeURIComponent(conversationBotTaskId);
  const botHeld=business(botConversationPath+"/prompt",{prompt:"FIXTURE-HOLD-BOT",botId:supervisorBotId,taskId:"individual-task"},"",{"x-leafcode-business-operation":botHoldPromptId});
  const botHoldDeadline=Date.now()+3000;while(!botHoldEntered&&Date.now()<botHoldDeadline)await delay(10);assert.ok(botHoldEntered,"Bot SDK provider hold was not entered");
  const botHeldAck=await botHeld;assert.equal(botHeldAck.status,200,JSON.stringify(botHeldAck));assert.equal(botHeldAck.body.task.id,conversationBotTaskId);
  const botStopped=await business(botConversationPath+"/abort",{botId:supervisorBotId,taskId:"individual-task",action:"delete"},"",{"x-leafcode-business-operation":botHoldAbortId});assert.equal(botStopped.status,200,JSON.stringify(botStopped));assert.equal(botStopped.body.task.id,conversationBotTaskId);
  const botClosedDeadline=Date.now()+2000;while(!botHoldClosed&&Date.now()<botClosedDeadline)await delay(10);assert.ok(botHoldClosed,"Bot Stop did not close the actual SDK provider");
  async function settledBot(){const deadline=Date.now()+3000;let value;while(Date.now()<deadline){value=await business(botTaskPath,undefined);if(value.status===200&&!value.body.task.isStreaming&&value.body.task.status!=="working")return value.body.task;await delay(20);}assert.fail("Bot did not settle: "+JSON.stringify(value));}
  await settledBot();
  const botPrompt=await business(botConversationPath+"/prompt",{prompt:"Fixture Bot accepted 日本語",files:[{name:"memo.txt",mimeType:"text/plain",data:"5pel5pys6Kqe"}],codeRequestId:"FORGED",permissionMode:"allow"},"",{"x-leafcode-business-operation":botPromptId});assert.equal(botPrompt.status,200,JSON.stringify(botPrompt));assert.equal(botPrompt.body.operation.execution,"complete");assert.ok(JSON.stringify(await settledBot()).includes(botAnswer));
  // Actual owner outbox cancellation over non-launched "starting" rows. No Code generation is launched.
  const oneToOneRequestId="a".repeat(64),roomRequestId="b".repeat(64),roomOutbox={id:roomRequestId,botId:conversationBotId,originTaskId:conversationRoomTaskId,codeTaskId:null,state:"starting",queuedAt:Date.now(),prompt:"Room pending context",baseline:null,room:{id:conversationRoomId,requestId:"room-user",responseId:"room-response"}};
  writeFileSync(join(outboxPath,oneToOneRequestId+".json"),JSON.stringify({...roomOutbox,id:oneToOneRequestId,originTaskId:conversationBotTaskId,room:undefined,prompt:"1:1 pending context"}));writeFileSync(join(outboxPath,roomRequestId+".json"),JSON.stringify(roomOutbox));const roomOutboxBytes=readFileSync(join(outboxPath,roomRequestId+".json"),"utf8");
  const botReverted=await business(botConversationPath+"/revert",{entryId:"bot-input",botId:supervisorBotId},"",{"x-leafcode-business-operation":botRevertId});assert.equal(botReverted.status,200,JSON.stringify(botReverted));assert.equal(botReverted.body.text,"Fixture Bot initial draft 日本語");assert.equal(botReverted.body.cancelledCodeRequests,1);assert.equal(botReverted.body.task.messages.length,0);assert.equal(JSON.parse(readFileSync(join(outboxPath,oneToOneRequestId+".json"),"utf8")).state,"cancelled");assert.equal(readFileSync(join(outboxPath,roomRequestId+".json"),"utf8"),roomOutboxBytes);
  // SDK leaf selection becomes durable on the next append, not on rewind alone.
  const botDurable=await business(botConversationPath+"/prompt",{prompt:"Fixture Bot durable after rewind 日本語"},"",{"x-leafcode-business-operation":botDurableId});assert.equal(botDurable.status,200,JSON.stringify(botDurable));const botTree=await settledBot();assert.ok(JSON.stringify(botTree).includes("Fixture Bot durable after rewind"));assert.ok(JSON.stringify(botTree).includes(botAnswer));assert.ok(!JSON.stringify(botTree).includes("Fixture Bot initial draft"));assert.equal(botRequests,3);const botSessionBytes=readFileSync(conversationSessionFile,"utf8");assert.ok(!botSessionBytes.includes('"type":"toolCall"'));assert.ok(!botSessionBytes.includes('"role":"toolResult"'));
  const botGoal=await business(botConversationPath+"/prompt",{prompt:"Fixture Bot state-only Goal 日本語",goalLoop:{acceptance:["No provider call"],maxTurns:2,forceFullRun:true}},"",{"x-leafcode-business-operation":botGoalId});assert.equal(botGoal.status,200,JSON.stringify(botGoal));assert.equal(botGoal.body.task,null);assert.equal(botGoal.body.loop.status,"queued");assert.equal(botGoal.body.loop.goal,"Fixture Bot state-only Goal 日本語");assert.equal(botRequests,3);
  const botGoalStop=await business(botConversationPath+"/abort",{},"",{"x-leafcode-business-operation":botGoalAbortId});assert.equal(botGoalStop.status,200,JSON.stringify(botGoalStop));assert.equal((await business(botTaskPath+"/goal-loop",undefined)).body.loop.status,"stopped");assert.equal(botRequests,3);
  const botLedger=readFileSync(join(data,"bot-conversation-command.json"),"utf8");for(const text of [conversationBotId,"Fixture Bot","memo.txt","5pel5pys6Kqe","FORGED"])assert.ok(!botLedger.includes(text));
  // State-only Goal commands may retain the SDK task lease; the real Stop settles it before tree edits.
  const beforeTreeStop=await business("tasks/individual-task/abort",{},"",{"x-leafcode-business-operation":"aaaaaaaa-7890-4321-abcd-eeeeeeeeeeee"});assert.equal(beforeTreeStop.status,200,JSON.stringify(beforeTreeStop));
  // Real SessionManager operations: branch/revert/restore/promotion need no model generation or tool.
  const forkOperation="abababab-7890-4321-abcd-eeeeeeeeeeee",forkSourceBefore=readFileSync(individualSessionFile,"utf8");
  const sessionFork=await business("tasks/individual-task/fork",{entryId:"ui100"},"",{"x-leafcode-business-operation":forkOperation});
  assert.equal(sessionFork.status,200,JSON.stringify(sessionFork));assert.equal(sessionFork.body.text,"isolated line 100");assert.equal(sessionFork.body.operation.execution,"complete");
  const forkTaskId=sessionFork.body.task.id;assert.notEqual(forkTaskId,"individual-task");assert.notEqual(sessionFork.body.task.sessionFile,individualSessionFile);assert.equal(readFileSync(individualSessionFile,"utf8"),forkSourceBefore);
  const forkDetail=await business(`tasks/${forkTaskId}`,undefined);assert.equal(forkDetail.body.task.messages.length,100);assert.ok(!forkDetail.body.task.messages.some(message=>message.id==="ui100"));
  const revertOperation="bcbcbcbc-7890-4321-abcd-eeeeeeeeeeee",unrevertOperation="cdcdcdcd-7890-4321-abcd-eeeeeeeeeeee";
  const reverted=await business(`tasks/${forkTaskId}/revert`,{entryId:"ui50"},"",{"x-leafcode-business-operation":revertOperation});
  assert.equal(reverted.status,200,JSON.stringify(reverted));assert.equal(reverted.body.text,"isolated line 50");assert.equal(reverted.body.task.messages.length,50);assert.ok(reverted.body.task.revertLeafId);
  const unreverted=await business(`tasks/${forkTaskId}/unrevert`,{},"",{"x-leafcode-business-operation":unrevertOperation});
  assert.equal(unreverted.status,200,JSON.stringify(unreverted));assert.equal(unreverted.body.task.messages.length,100);assert.equal(unreverted.body.task.revertLeafId,null);
  const revertRestartOperation="dededede-7890-4321-abcd-eeeeeeeeeeee";
  assert.equal((await business(`tasks/${forkTaskId}/revert`,{entryId:"ui50"},"",{"x-leafcode-business-operation":revertRestartOperation})).status,200);
  const promotionOperation="efefefef-7890-4321-abcd-eeeeeeeeeeee";
  const promoted=await business("tasks/session-promotion-task/promote",{destinationPath:promotionDestination},"",{"x-leafcode-business-operation":promotionOperation});
  assert.equal(promoted.status,200,JSON.stringify(promoted));assert.equal(promoted.body.operation.execution,"complete");assert.equal(promoted.body.task.directory,promotionDestination);assert.equal(promoted.body.project.rootPath,promotionDestination);assert.notEqual(promoted.body.task.sessionFile,promotionSessionFile);
  assert.equal(existsSync(promotionSource),false);assert.equal(readFileSync(join(promotionDestination,"keep-promotion.txt"),"utf8"),"fixture workspace 日本語");
  const sessionLedger=readFileSync(join(data,"task-session-command.json"),"utf8");assert.ok(!sessionLedger.includes("isolated line"));assert.ok(!sessionLedger.includes(promotionDestination));assert.ok(!sessionLedger.includes("ui50"));
  // Real direct-generation reads history without altering the agent's conversation/Goal/permissions.
  const helperModel={providerID:"fixture-helper",modelID:"fixture-helper"},assistanceSourceBefore=readFileSync(individualSessionFile,"utf8");
  const assistanceProgressId="aaaaaaaa-9012-4321-abcd-eeeeeeeeeeee",assistanceNextId="abababab-9012-4321-abcd-eeeeeeeeeeee",assistanceTitleId="bcbcbcbc-9012-4321-abcd-eeeeeeeeeeee",assistancePatchId="cdcdcdcd-9012-4321-abcd-eeeeeeeeeeee",assistanceLabelId="dededede-9012-4321-abcd-eeeeeeeeeeee",assistanceAdviceId="efefefef-9012-4321-abcd-eeeeeeeeeeee",assistanceCancelId="fafafafa-9012-4321-abcd-eeeeeeeeeeee";
  const assistanceProgress=await business("tasks/individual-task/progress",{question:"Fixture progress 日本語",model:helperModel},"",{"x-leafcode-business-operation":assistanceProgressId});assert.equal(assistanceProgress.status,200,JSON.stringify(assistanceProgress));assert.equal(assistanceProgress.body.answer,helperAnswer);assert.equal(assistanceProgress.body.working,false);assert.equal(assistanceProgress.body.operation.execution,"complete");
  const assistanceNext=await business("tasks/individual-task/next-action",{model:helperModel,previousSuggestions:["old"]},"",{"x-leafcode-business-operation":assistanceNextId});assert.equal(assistanceNext.status,200,JSON.stringify(assistanceNext));assert.equal(assistanceNext.body.suggestion,helperAnswer);
  const assistanceTitle=await business("tasks/individual-task/title",{model:helperModel},"",{"x-leafcode-business-operation":assistanceTitleId});assert.equal(assistanceTitle.status,200,JSON.stringify(assistanceTitle));assert.equal(assistanceTitle.body.title,helperTitle);
  const assistanceLabel=await business("tasks/individual-task/title",{labelOnly:true},"",{"x-leafcode-business-operation":assistanceLabelId});assert.equal(assistanceLabel.status,200,JSON.stringify(assistanceLabel));
  const assistanceAdvice=await business("tasks/individual-task/permission/advice",{requestId:"fixture-expired",command:"FORGED",allow:true},"",{"x-leafcode-business-operation":assistanceAdviceId});assert.equal(assistanceAdvice.status,404);assert.equal(helperRequests,3);
  const progressController=new AbortController(),pendingProgress=fetch(`${base}/internal/json-business/tasks/individual-task/progress`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":assistanceCancelId},body:JSON.stringify({question:"FIXTURE-HOLD-PROGRESS",model:helperModel}),signal:progressController.signal}).catch(()=>null);
  const helperWait=Date.now()+2000;while(!helperHoldEntered&&Date.now()<helperWait)await delay(10);assert.ok(helperHoldEntered);progressController.abort();await pendingProgress;
  const helperCloseWait=Date.now()+2000;while(!helperHoldClosed&&Date.now()<helperCloseWait)await delay(10);assert.ok(helperHoldClosed,"Progress disconnect did not cancel real SDK provider");
  const manualTitle="Fixture manual title 日本語";
  const assistancePatch=await business("tasks/individual-task/title",{title:`  ${manualTitle}  `},"",{"x-leafcode-business-operation":assistancePatchId},"PATCH");assert.equal(assistancePatch.status,200,JSON.stringify(assistancePatch));assert.equal(assistancePatch.body.title,manualTitle);assert.equal(assistancePatch.body.task.titleAutoUpdate,false);
  assert.equal(readFileSync(individualSessionFile,"utf8"),assistanceSourceBefore);assert.equal(helperRequests,4);
  const assistanceLedger=readFileSync(join(data,"task-assistance-command.json"),"utf8");for(const privateText of [manualTitle,helperTitle,"Fixture progress",individualSessionFile,"fixture-expired","FIXTURE-HOLD-PROGRESS"])assert.ok(!assistanceLedger.includes(privateText));
  // Actual SDK admission targets only the unreachable localhost fixture model, never a paid provider or tool.
  const conversationPromptId="abababab-5678-4321-abcd-eeeeeeeeeeee";
  const fixturePrompt="Fixture local-only conversation request";
  const acceptedPrompt=await business("tasks/individual-task/prompt",{prompt:fixturePrompt},"",{"x-leafcode-business-operation":conversationPromptId});
  assert.equal(acceptedPrompt.status,200,JSON.stringify(acceptedPrompt));assert.equal(acceptedPrompt.body.task.id,"individual-task");assert.equal(acceptedPrompt.body.operation.execution,"complete");
  const conversationPermissionId="cdcdcdcd-5678-4321-abcd-eeeeeeeeeeee",conversationQuestionId="dededede-5678-4321-abcd-eeeeeeeeeeee";
  const stalePermission=await business("tasks/individual-task/permission",{requestId:"fixture-expired",approved:false},"",{"x-leafcode-business-operation":conversationPermissionId});
  const staleQuestion=await business("tasks/individual-task/question",{requestId:"fixture-expired",answers:[["Fixture private 日本語"]]},"",{"x-leafcode-business-operation":conversationQuestionId});
  assert.equal(stalePermission.status,404);assert.equal(staleQuestion.status,404);assert.equal(stalePermission.body.operation.execution,"complete");assert.equal(staleQuestion.body.operation.execution,"complete");
  const conversationLedger=readFileSync(join(data,"task-conversation-command.json"),"utf8");assert.ok(!conversationLedger.includes(fixturePrompt));assert.ok(!conversationLedger.includes("fixture-expired"));assert.ok(!conversationLedger.includes("Fixture private"));
  assert.equal((await business("tasks/individual-task/prompt",{prompt:fixturePrompt},"",{"x-leafcode-business-operation":conversationPromptId})).status,409);
  const individualStop = await business("tasks/individual-task/abort", {}, "", { "x-leafcode-business-operation": "dfdfdfdf-bbbb-cccc-dddd-eeeeeeeeeeee" }); assert.equal(individualStop.status, 200);
  const individualArchive = await fetch(`${base}/internal/json-business/tasks/individual-task`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": "eaeaeaea-bbbb-cccc-dddd-eeeeeeeeeeee" }, signal: AbortSignal.timeout(5000) }); assert.equal((await individualArchive.json()).body.task.status, "archived");
  assert.equal((await business("tasks/%252F", undefined)).status, 400);
  // Restart the actual owner process, retaining only its disk state, not a Web fallback or a module cache.
  const exited = new Promise((done) => child.once("exit", done)); child.kill(); await exited;
  stdout = ""; stderr = ""; listening = undefined; child = launch();
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const restartDeadline = Date.now() + 8_000;
  while (!listening && Date.now() < restartDeadline && child.exitCode === null) {
    for (const line of stdout.split(/\\r?\\n/)) {
      try { const record = JSON.parse(line); if (record.type === "backend_listening") listening = record; } catch { /* partial line */ }
    }
    if (!listening) await delay(25);
  }
  assert.ok(listening, stderr);
  const restartedBase = `http://127.0.0.1:${listening.port}`;
  let restored;
  while (Date.now() < restartDeadline) {
    const reply = await fetch(`${restartedBase}/internal/configuration/settings/history-page-size`, { headers: configHeaders, signal: AbortSignal.timeout(3_000) });
    if (reply.status === 200) { restored = await reply.json(); break; }
    await delay(50);
  }
  assert.equal(restored?.value, "100", stderr);
  const outcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${committed.mutation.operationId}`, { headers: configHeaders, signal: AbortSignal.timeout(3_000) });
  assert.equal(outcome.status, 200); assert.deepEqual((await outcome.json()).mutation, committed.mutation);
  for(const [action,id,body] of [["prompt",botHoldPromptId,{prompt:"FIXTURE-HOLD-BOT"}],["abort",botHoldAbortId,{}],["prompt",botPromptId,{prompt:"different"}],["revert",botRevertId,{entryId:"bot-input"}],["prompt",botDurableId,{prompt:"different"}],["prompt",botGoalId,{prompt:"different",goalLoop:{}}],["abort",botGoalAbortId,{}]]){
    const response=await fetch(restartedBase+"/internal/json-business/"+botConversationPath+"/"+action,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":id},body:JSON.stringify(body)});assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.operation.execution,"complete");
  }
  const restoredBotTreeResponse=await fetch(restartedBase+"/internal/json-business/"+botTaskPath,{headers:businessHeaders});assert.equal(restoredBotTreeResponse.status,200);const restoredBotTree=await restoredBotTreeResponse.json();assert.ok(JSON.stringify(restoredBotTree.body.task.messages).includes("Fixture Bot durable after rewind"));assert.ok(!JSON.stringify(restoredBotTree.body.task.messages).includes("Fixture Bot initial draft"));assert.ok(JSON.stringify(restoredBotTree.body.task.messages).includes(botAnswer));assert.equal(botRequests,3);assert.equal(readFileSync(join(outboxPath,roomRequestId+".json"),"utf8"),roomOutboxBytes);
  for(const [suffix,id,body] of [["prompt",conversationPromptId,{prompt:fixturePrompt}],["permission",conversationPermissionId,{requestId:"fixture-expired",approved:true}],["question",conversationQuestionId,{requestId:"fixture-expired",reject:true}]]) {
    const replay=await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/${suffix}`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":id},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
    assert.equal(replay.status,200);const result=await replay.json();assert.equal(result.status,409);assert.equal(result.body.operation.execution,"complete");
  }
  const goalAfterRestart=await fetch(`${restartedBase}/internal/json-business/${goalPath}`,{headers:businessHeaders,signal:AbortSignal.timeout(3000)});const restoredGoal=await goalAfterRestart.json();assert.equal(restoredGoal.body.loop.status,"stopped");assert.equal(restoredGoal.body.loop.goal,goalText);assert.ok(!JSON.stringify(restoredGoal).includes("PRIVATE-GOAL-TOKEN"));
  const goalReplay=await fetch(`${restartedBase}/internal/json-business/${goalPath}`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":goalStartId},body:JSON.stringify({action:"start",goal:"Do not start again"}),signal:AbortSignal.timeout(3000)});const deniedGoalReplay=await goalReplay.json();assert.equal(deniedGoalReplay.status,409);assert.equal(deniedGoalReplay.body.operation.execution,"complete");
  const goalControlReplay=await fetch(`${restartedBase}/internal/json-business/${goalPath}`,{method:"PATCH",headers:{...businessHeaders,"x-leafcode-business-operation":goalControlIds[1]},body:JSON.stringify({action:"resume"}),signal:AbortSignal.timeout(3000)});assert.equal((await goalControlReplay.json()).status,409);
  const gitAfterRestart = await fetch(`${restartedBase}/internal/json-business/git/log${query}`, { headers: businessHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal(gitAfterRestart.status, 200);
  assert.equal((await gitAfterRestart.json()).body.commits[0].hash, history.body.commits[0].hash);
  const definitionRestored = await fetch(`${restartedBase}/internal/json-business/agents-md`, { headers: businessHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal((await definitionRestored.json()).body.content, "Isolated owner 日本語");
  const definitionOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${definitionOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await definitionOutcome.json()).mutation, definitionReply.body.mutation);
  const definitionReplay = await fetch(`${restartedBase}/internal/json-business/agents-md`, { method: "PATCH", headers: { ...businessHeaders, "x-leafcode-business-operation": definitionOperation },
    body: JSON.stringify({ content: "No replay" }), signal: AbortSignal.timeout(5000) });
  assert.equal((await definitionReplay.json()).status, 409);
  assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), "Isolated owner 日本語");
  const endpointRestored = await fetch(`${restartedBase}/internal/json-business/providers/leafcodecloud/base-url`, { headers: businessHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal((await endpointRestored.json()).body.baseUrl, "http://127.0.0.1:1/v1");
  const endpointOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${endpointOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await endpointOutcome.json()).mutation, endpointReply.body.mutation);
  assert.equal(JSON.parse(readFileSync(join(data, "provider-model-state.json"), "utf8")).contextWindow["fixture::model"], 16384);
  const authReplay = await fetch(`${restartedBase}/internal/json-business/providers/fixture/login`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": authOperation }, body: JSON.stringify({ type: "invalid" }), signal: AbortSignal.timeout(3000) });
  assert.equal((await authReplay.json()).status, 409);
  const accountsRestored = await fetch(`${restartedBase}/internal/json-business/accounts`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal((await accountsRestored.json()).body.accounts[0].id, accountId);
  const accountStatusRestored = await fetch(`${restartedBase}/internal/json-business/accounts/${accountId}/auth-status`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  const restoredStatus = await accountStatusRestored.json(); assert.equal(restoredStatus.body.openrouterManagementKeyConfigured, true); assert.ok(!JSON.stringify(restoredStatus).includes("PRIVATE"));
  const creditOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${creditOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await creditOutcome.json()).mutation, creditReply.body.mutation);
  const accountReplay = await fetch(`${restartedBase}/internal/json-business/accounts`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": accountOperation }, body: JSON.stringify({ label: "No replay", providers: ["openrouter"] }), signal: AbortSignal.timeout(3000) });
  assert.equal((await accountReplay.json()).status, 409);
  const creditReplay = await fetch(`${restartedBase}/internal/json-business/accounts/${accountId}/openrouter-credits`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": creditOperation }, body: JSON.stringify({ managementKey: "PRIVATE-NO-REPLAY" }), signal: AbortSignal.timeout(3000) });
  assert.equal((await creditReplay.json()).status, 409); assert.equal(JSON.parse(readFileSync(creditPath, "utf8")).managementKey, "PRIVATE-FIXTURE-KEY");
  const usageCatalogRestored = await fetch(`${restartedBase}/internal/json-business/codexbar/providers`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal((await usageCatalogRestored.json()).body.version, usageConfig.body.version);
  const usageConfigOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${usageConfigOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await usageConfigOutcome.json()).mutation, usageConfig.body.mutation);
  const consumeReplay = await fetch(`${restartedBase}/internal/json-business/codexbar/reset-credits`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": usageOperation }, body: JSON.stringify({ creditId: "must-not-execute" }), signal: AbortSignal.timeout(3000) });
  assert.equal((await consumeReplay.json()).status, 409);
  const individualReload = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task?messages=page`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); const individualReloaded = await individualReload.json(); assert.equal(individualReloaded.body.task.status, "archived"); assert.equal(individualReloaded.body.task.messages.length, 100);
  const individualReplay = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task`, { method: "PATCH", headers: { ...businessHeaders, "x-leafcode-business-operation": individualRestoreId }, body: JSON.stringify({ archived: false }), signal: AbortSignal.timeout(3000) }); assert.equal((await individualReplay.json()).status, 409);
  assert.equal(individualReloaded.body.task.providerID,"fixture-local"); assert.equal(individualReloaded.body.task.modelID,"fixture-model");
  assert.equal(JSON.parse(readFileSync(savedPath,"utf8"))["goal-loop-auto-model:individual-task"],"fixture-stamp");
  const settingsReplay = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/model`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":taskSettingsModelId},body:JSON.stringify({model:"fixture-local::fixture-model"}),signal:AbortSignal.timeout(3000)}); assert.equal((await settingsReplay.json()).status,409);
  const autoReplay = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/goal-loop-auto-model`,{method:"PUT",headers:{...businessHeaders,"x-leafcode-business-operation":taskSettingsAutoId},body:JSON.stringify({enabled:true}),signal:AbortSignal.timeout(3000)}); assert.equal((await autoReplay.json()).status,409);
  const disableAuto = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/goal-loop-auto-model`,{method:"PUT",headers:{...businessHeaders,"x-leafcode-business-operation":"abababab-5678-4321-abcd-eeeeeeeeeeee"},body:JSON.stringify({enabled:false}),signal:AbortSignal.timeout(3000)}); assert.equal((await disableAuto.json()).body.enabled,false); assert.equal(JSON.parse(readFileSync(savedPath,"utf8"))["goal-loop-auto-model:individual-task"],undefined);
  for(const [path,id] of [["tasks/compaction-task/compact",compactSuccessId],["tasks/compaction-task/compact",compactCancelId],["tasks/compaction-task/compact/abort",compactAbortId],["tasks/compaction-task/compact/abort",compactColdAbortId]]){
    const replay=await fetch(`${restartedBase}/internal/json-business/${path}`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":id},body:JSON.stringify({customInstructions:"NO-REPLAY"}),signal:AbortSignal.timeout(3000)});assert.equal((await replay.json()).status,409);
  }
  for(const [action,id,method] of [["progress",assistanceProgressId,"POST"],["progress",assistanceCancelId,"POST"],["next-action",assistanceNextId,"POST"],["title",assistanceTitleId,"POST"],["title",assistanceLabelId,"POST"],["title",assistancePatchId,"PATCH"],["permission/advice",assistanceAdviceId,"POST"]]){
    const replay=await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/${action}`,{method,headers:{...businessHeaders,"x-leafcode-business-operation":id},body:"{}",signal:AbortSignal.timeout(3000)});assert.equal(replay.status,200);const result=await replay.json();assert.equal(result.status,409);assert.equal(result.body.operation.execution,id===assistanceCancelId?"unknown":"complete");
  }
  const lifecycleRestoredReply=await fetch(`${restartedBase}/internal/json-business/bots/${lifecycleBot.id}`,{headers:businessHeaders,signal:AbortSignal.timeout(3000)});const lifecycleRestored=(await lifecycleRestoredReply.json()).body.bot;assert.equal(lifecycleRestored.name,"Fixture renamed 日本語");assert.deepEqual(lifecycleRestored.tools,["read"]);assert.deepEqual(lifecycleRestored.skills,{mode:"include",include:["fixture-skill"],exclude:[]});assert.deepEqual(lifecycleRestored.extraRoots,[lifecycleWorkspace]);
  for(const [path,id,method] of [["bots",lifecycleCreateId,"POST"],["bots/"+lifecycleBot.id,lifecyclePatchId,"PATCH"],["bots/"+lifecycleDeleteBotId,lifecycleDeleteId,"DELETE"]]){const replay=await fetch(`${restartedBase}/internal/json-business/${path}`,{method,headers:{...businessHeaders,"x-leafcode-business-operation":id},body:JSON.stringify({name:"NO-REPLAY"}),signal:AbortSignal.timeout(3000)});assert.equal((await replay.json()).status,409);}
  assert.equal(existsSync(lifecycleDeleteRoot),false);assert.deepEqual(JSON.parse(readFileSync(join(lifecycleRoomRoot,lifecycleRoomId+".json"),"utf8")).members,[supervisorBotId]);assert.equal(readFileSync(join(lifecycleWorkspace,"keep.txt"),"utf8"),"keep lifecycle workspace");
  const assistanceRestored=JSON.parse(readFileSync(join(data,"store.json"),"utf8")).tasks.find(task=>task.id==="individual-task");assert.equal(assistanceRestored.title,"Fixture manual title 日本語");assert.equal(assistanceRestored.titleAutoUpdate,false);assert.equal(helperRequests,4);
  for(const id of [supervisorHandoffId,supervisorReleaseId]){
    const replay=await fetch(`${restartedBase}/internal/json-business/tasks/compaction-task/supervisor`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":id},body:JSON.stringify({botId:supervisorBotId}),signal:AbortSignal.timeout(3000)});assert.equal((await replay.json()).status,409);
  }
  const supervisorRestored=JSON.parse(readFileSync(join(data,"store.json"),"utf8")).tasks.find(task=>task.id==="compaction-task");assert.equal(supervisorRestored.supervisorBotId,null);assert.equal(JSON.parse(readFileSync(join(outboxPath,supervisionRequests[0].id+".json"),"utf8")).state,"cancelled");
  const childAfterRestart=await fetch(`${restartedBase}/internal/json-business/tasks/compaction-task/subagents`,{headers:businessHeaders,signal:AbortSignal.timeout(3000)});assert.ok((await childAfterRestart.json()).body.runs.some(run=>run.runId==="fixture-child"));assert.equal(readFileSync(childTranscript,"utf8").split("\n").filter(Boolean).length,3);
  const compactAfterRestart=await fetch(`${restartedBase}/internal/json-business/tasks/compaction-task`,{headers:businessHeaders,signal:AbortSignal.timeout(5000)});const restoredCompaction=(await compactAfterRestart.json()).body.task;assert.ok(JSON.stringify(restoredCompaction.messages).includes(compactSummary));assert.equal(restoredCompaction.isCompacting,false);assert.equal(compactRequests,2);
  for(const [path,id] of [["tasks/individual-task/fork",forkOperation],[`tasks/${forkTaskId}/revert`,revertOperation],[`tasks/${forkTaskId}/unrevert`,unrevertOperation],["tasks/session-promotion-task/promote",promotionOperation]]) {
    const replay=await fetch(`${restartedBase}/internal/json-business/${path}`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":id},body:JSON.stringify({entryId:"ui0",destinationPath:promotionDestination}),signal:AbortSignal.timeout(5000)});assert.equal((await replay.json()).status,409);
  }
  const forkAfterRestart=await fetch(`${restartedBase}/internal/json-business/tasks/${forkTaskId}`,{headers:businessHeaders,signal:AbortSignal.timeout(5000)});const restartedFork=(await forkAfterRestart.json()).body.task;
  // Existing SDK branch()/navigateTree() selection is in-memory until the next append; only the undo marker is durable.
  // Preserve this baseline limitation explicitly rather than claiming selected-leaf durability at command ACK.
  assert.equal(restartedFork.messages.length,100);assert.ok(restartedFork.revertLeafId);
  const restoreAfterRestart=await fetch(`${restartedBase}/internal/json-business/tasks/${forkTaskId}/unrevert`,{method:"POST",headers:{...businessHeaders,"x-leafcode-business-operation":"fafafafa-7890-4321-abcd-eeeeeeeeeeee"},body:"{}",signal:AbortSignal.timeout(5000)});const restoredFork=await restoreAfterRestart.json();assert.equal(restoredFork.status,200,JSON.stringify(restoredFork));assert.equal(restoredFork.body.task.messages.length,100);assert.equal(restoredFork.body.task.revertLeafId,null);
  const promotedAfterRestart=await fetch(`${restartedBase}/internal/json-business/tasks/session-promotion-task`,{headers:businessHeaders,signal:AbortSignal.timeout(5000)});assert.equal((await promotedAfterRestart.json()).body.task.directory,promotionDestination);assert.equal(readFileSync(join(promotionDestination,"keep-promotion.txt"),"utf8"),"fixture workspace 日本語");
  const historyReload = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/bookmarks?verify=1`, {headers:businessHeaders,signal:AbortSignal.timeout(3000)}); const historyReloaded = await historyReload.json(); assert.equal(historyReloaded.body.bookmarks[0].messageId,"ui0"); assert.deepEqual(historyReloaded.body.missing,[]);
  const bookmarkReplay = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/bookmarks`, {method:"PUT",headers:{...businessHeaders,"x-leafcode-business-operation":bookmarkId},body:JSON.stringify({messageId:"ui1",role:"user"}),signal:AbortSignal.timeout(3000)}); assert.equal((await bookmarkReplay.json()).status,409);
  const bookmarkDeleted = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task/bookmarks?messageId=ui0`, {method:"DELETE",headers:{...businessHeaders,"x-leafcode-business-operation":"bcbcbcbc-1234-4321-abcd-eeeeeeeeeeee"},signal:AbortSignal.timeout(3000)}); assert.deepEqual((await bookmarkDeleted.json()).body.bookmarks,[]);
  const individualDelete = await fetch(`${restartedBase}/internal/json-business/tasks/individual-task?hard=1`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": "fbfbfbfb-bbbb-cccc-dddd-eeeeeeeeeeee" }, signal: AbortSignal.timeout(3000) }); assert.equal((await individualDelete.json()).body.ok, true); assert.ok(readFileSync(individualSessionFile, "utf8").includes("isolated line 204"));
  const taskReplay = await fetch(`${restartedBase}/internal/json-business/tasks?noProject=1`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": taskBulkId }, signal: AbortSignal.timeout(3000) }); assert.equal((await taskReplay.json()).status, 409);
  const taskReload = await fetch(`${restartedBase}/internal/json-business/tasks?titles=1&archived=1&kind=all`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); const taskReloaded = (await taskReload.json()).body.tasks; assert.ok(!taskReloaded.some(task => task.id === "task-collection-archived")); assert.ok(taskReloaded.some(task => task.id === "independent-task"));
  const taskCreateReplay = await fetch(`${restartedBase}/internal/json-business/tasks`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": taskCreateId }, body: JSON.stringify({ projectId: "missing-fixture-project", prompt: "no paid generation" }), signal: AbortSignal.timeout(3000) }); assert.equal((await taskCreateReplay.json()).status, 409);
  const projectReplay = await fetch(`${restartedBase}/internal/json-business/projects`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": projectOperation }, body: JSON.stringify({ rootPath: lifecycleDestination }), signal: AbortSignal.timeout(3000) }); assert.equal((await projectReplay.json()).status, 409);
  const lifecycleList = await fetch(`${restartedBase}/internal/json-business/projects?archived=1`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); const lifecycleMetadata = (await lifecycleList.json()).body.projects.find(project => project.id === lifecycleId); assert.equal(lifecycleMetadata.rootPath, lifecycleDestination); assert.equal(lifecycleMetadata.archived, false);
  const lifecycleDelete = await fetch(`${restartedBase}/internal/json-business/projects?id=${lifecycleId}`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": "fafafafa-bbbb-cccc-dddd-eeeeeeeeeeee" }, signal: AbortSignal.timeout(3000) }); assert.equal((await lifecycleDelete.json()).status, 200); assert.equal(existsSync(join(lifecycleDestination, "keep.txt")), true);
  const restartedFile = await fetch(`${restartedBase}/internal/json-business/projects/fixture-project/files?path=README.md&read=1`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); const restoredFile = await restartedFile.json(); assert.equal(restoredFile.status, 200); assert.deepEqual(restoredFile.body, workspaceFile.body);
  const peerLeaseRestored = await peerRequest(restartedBase, "peer-auth/resolve", { providerId: "openrouter", accountId }); assert.deepEqual(peerLeaseRestored.body, peerLease.body);
  const peerGrantReplay = await fetch(`${restartedBase}/internal/json-business/peer-auth/peers`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": peerOperation }, body: JSON.stringify({ label: "No replay", providers: ["openrouter"] }), signal: AbortSignal.timeout(3000) }); assert.equal((await peerGrantReplay.json()).status, 409);
  const peerMetadata = await fetch(`${restartedBase}/internal/json-business/peer-auth/peers`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); assert.ok(!JSON.stringify(await peerMetadata.json()).includes(peerToken));
  const peerRevoke = await fetch(`${restartedBase}/internal/json-business/peer-auth/peers?id=${peerGrantReply.body.grant.id}`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": "99999999-aaaa-bbbb-cccc-dddddddddddd" }, signal: AbortSignal.timeout(3000) }); assert.equal((await peerRevoke.json()).status, 200);
  assert.equal((await peerRequest(restartedBase, "peer-auth/list")).status, 401);
  assert.equal(existsSync(join(fixture, "web")), false);
});
