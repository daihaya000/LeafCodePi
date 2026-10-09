import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TASK_GOAL_LOOP_ROUTES, taskGoalLoopTarget, taskGoalLoopBodyLimit } from "./task-goal-loop-contract.mjs";
import { JSON_BUSINESS_ROUTES, jsonBusinessTarget, jsonBusinessCommand, jsonBusinessMutates, jsonBusinessBodyLimit, publicJsonBusinessResult } from "./json-business-contract.mjs";
const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
test("two routes/four operations own reads/control/start with one decode and method-aware attachment budget",()=>{
 assert.deepEqual(JSON_BUSINESS_ROUTES["tasks/[id]/goal-loop"],["GET","POST","PATCH"]);assert.equal(Object.values(TASK_GOAL_LOOP_ROUTES).flat().length,4);
 assert.equal(taskGoalLoopTarget("tasks/bot%3Afixture/goal-loop").params.id,"bot:fixture");assert.equal(taskGoalLoopTarget("tasks/%252F/goal-loop").params.id,"%2F");assert.equal(taskGoalLoopTarget("tasks/%/goal-loop"),null);
 assert.equal(jsonBusinessTarget("goal-loop/active").route,"goal-loop/active");assert.equal(taskGoalLoopTarget("tasks/t/goal-loop/extra"),null);
 for(const method of ["POST","PATCH"]){assert.equal(jsonBusinessCommand("tasks/t/goal-loop",method),true);assert.equal(jsonBusinessMutates("tasks/t/goal-loop",method),true);}
 assert.equal(jsonBusinessCommand("tasks/t/goal-loop","GET"),false);assert.equal(jsonBusinessMutates("goal-loop/active","GET"),false);
 assert.equal(jsonBusinessBodyLimit("tasks/t/goal-loop","POST"),18*1024*1024);assert.equal(jsonBusinessBodyLimit("tasks/t/goal-loop","PATCH"),4096);assert.equal(taskGoalLoopBodyLimit("goal-loop/active","GET"),4096);
});
test("Goal read keeps nullable/partial historical state, but successful commands require a valid observed loop",()=>{
 assert.deepEqual(publicJsonBusinessResult("tasks/t/goal-loop",{status:200,body:{loop:null}},"GET").body,{loop:null});
 assert.equal(publicJsonBusinessResult("tasks/t/goal-loop",{status:200,body:{loop:null}},"POST"),null);assert.equal(publicJsonBusinessResult("tasks/t/goal-loop",{status:200,body:{loop:null}},"PATCH"),null);
 for(const loop of [undefined,{}, {status:"bad"}, {status:"queued",progress:[{summary:2}]}])assert.equal(publicJsonBusinessResult("tasks/t/goal-loop",{status:200,body:{loop}},"GET"),null);
 assert.equal(publicJsonBusinessResult("tasks/t/goal-loop",{status:200,body:{loop:{status:"paused",goal:"historical",progress:[],turnCount:0}}},"GET").body.loop.goal,"historical");
});
test("Goal, progress/images, Agent and Auto escalation deeply exclude SDK/private fields and headers",()=>{
 const result=publicJsonBusinessResult("tasks/t/goal-loop",{status:200,headers:{"set-cookie":"PRIVATE",etag:"e"},body:{loop:{id:"g",sessionId:"s",status:"queued",goal:"authored",acceptance:["criteria"],progress:[{summary:"authored",token:"PRIVATE"}],initialImages:[{mimeType:"image/png",data:"YQ==",headers:"PRIVATE"}],session:{token:"PRIVATE"}},agent:null,autoDecision:{providerID:"p",modelID:"m",escalation:{providerID:"p",modelID:"b",token:"PRIVATE"}},operation:{id,execution:"complete",token:"PRIVATE"},token:"PRIVATE"}},"POST");
 assert.equal(result.body.loop.progress[0].summary,"authored");assert.equal(result.body.loop.initialImages[0].data,"YQ==");assert.equal(result.body.autoDecision.escalation.modelID,"b");assert.deepEqual(result.body.operation,{id,execution:"complete"});assert.deepEqual(result.headers,{etag:"e"});assert.ok(!JSON.stringify(result).includes("PRIVATE"));
 assert.equal(publicJsonBusinessResult("tasks/t/goal-loop",{status:200,body:{loop:{status:"queued"},agent:3}},"POST"),null);
});
test("active inventory cannot hide failures as an empty list or retain extra owner fields",()=>{
 assert.deepEqual(publicJsonBusinessResult("goal-loop/active",{status:200,body:{active:2,taskIds:["t","bot:b"],pid:"PRIVATE"}},"GET").body,{active:2,taskIds:["t","bot:b"]});
 for(const body of [{},{active:0,taskIds:["t"]},{active:1,taskIds:[null]},{active:"0",taskIds:[]}])assert.equal(publicJsonBusinessResult("goal-loop/active",{status:200,body},"GET"),null);
 assert.deepEqual(publicJsonBusinessResult("tasks/t/goal-loop",{status:503,body:{error:"unknown",operation:{id,execution:"unknown"},loop:{token:"PRIVATE"}}},"PATCH").body,{error:"unknown",operation:{id,execution:"unknown"}});
});
test("Goal contracts and reused DTO projections are SDK/FS/singleton-free",()=>{
 for(const name of ["task-goal-loop-contract.mjs","task-lifecycle-contract.mjs","task-collection-contract.mjs"])assert.doesNotMatch(readFileSync(new URL(name,import.meta.url),"utf8"),/node:|next\/|process\.|readFile|writeFile|@earendil/);
});
