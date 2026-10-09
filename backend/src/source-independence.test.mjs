import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const helperBase=`http://127.0.0.1:${helperProvider.address().port}/v1`;
  writeFileSync(join(agent,"settings.json"),JSON.stringify({compaction:{keepRecentTokens:256},packages:[]}));
  // Ordinary prompt still targets the unreachable endpoint. Only explicit compaction uses the local responder.
  writeFileSync(join(agent,"models.json"),JSON.stringify({providers:{"fixture-local":{baseUrl:"http://127.0.0.1:9/v1",apiKey:"fixture-only-not-a-real-key",api:"openai-completions",models:[{id:"fixture-model",name:"Fixture",reasoning:true,input:["text"],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]},"fixture-helper":{baseUrl:helperBase,apiKey:"fixture-only-not-a-real-key",api:"openai-completions",models:[{id:"fixture-helper",name:"Fixture helper",reasoning:false,input:["text"],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]},"fixture-compactor":{baseUrl:compactBase,apiKey:"fixture-only-not-a-real-key",api:"openai-completions",models:[{id:"fixture-compactor",name:"Fixture compactor",reasoning:false,input:["text"],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
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
  const compactAborted=await business("tasks/compaction-task/compact/abort",{},"",{"x-leafcode-business-operation":compactAbortId});assert.equal(compactAborted.status,200,JSON.stringify(compactAborted));assert.equal(compactAborted.body.operation.execution,"complete");
  const cancelledCompaction=await compactCancelled;assert.equal(cancelledCompaction.status,400,JSON.stringify(cancelledCompaction));assert.equal(cancelledCompaction.body.operation.execution,"complete");
  const closeWait=Date.now()+1000;while(!compactHoldClosed&&Date.now()<closeWait)await delay(10);assert.ok(compactHoldClosed);assert.ok(!readFileSync(compactSessionFile,"utf8").includes('"type":"compaction"'));
  const compactCompleted=await business("tasks/compaction-task/compact",{customInstructions:compactFocus},"",{"x-leafcode-business-operation":compactSuccessId});assert.equal(compactCompleted.status,200,JSON.stringify(compactCompleted));assert.equal(compactCompleted.body.operation.execution,"complete");assert.equal(compactCompleted.body.task.isCompacting,false);assert.ok(JSON.stringify(compactCompleted.body.task.messages).includes(compactSummary));assert.ok(compactFocusSeen);assert.equal(compactRequests,2);
  const persistedCompaction=readFileSync(compactSessionFile,"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.type==="compaction");assert.equal(persistedCompaction.length,1);assert.equal(persistedCompaction[0].summary,compactSummary);
  const compactLedger=readFileSync(join(data,"task-compaction-command.json"),"utf8");assert.ok(!compactLedger.includes(compactFocus));assert.ok(!compactLedger.includes("FIXTURE-HOLD-COMPACTION"));
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
  const assistanceRestored=JSON.parse(readFileSync(join(data,"store.json"),"utf8")).tasks.find(task=>task.id==="individual-task");assert.equal(assistanceRestored.title,"Fixture manual title 日本語");assert.equal(assistanceRestored.titleAutoUpdate,false);assert.equal(helperRequests,4);
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
