import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taskSupervisionTarget, publicSubagentRun, publicTaskSupervisionBody } from "./task-supervision-contract.mjs";
import { jsonBusinessBodyLimit, jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
const run={runId:"r",agent:"coder",index:0,status:"running",startedAtMs:1,lastActivityAtMs:2,currentTool:"bash",provider:"p",model:"m",truncated:true,token:"PRIVATE",messages:[{id:"a",role:"assistant",createdAt:1,token:"PRIVATE",parts:[{id:"t",type:"thinking",text:"authored",token:"PRIVATE"},{id:"tool",type:"tool",tool:"bash",callID:"c",state:{status:"running",token:"PRIVATE",input:{userAuthored:{nested:[1,"日本語"]}},nestedCalls:[{id:"n",name:"read",status:"ok",args:"PRIVATE"}]}}]}]};
test("supervision wire is pure; target/operation and 4KiB bounds are scoped",()=>{
 assert.doesNotMatch(readFileSync(new URL("./task-supervision-contract.mjs",import.meta.url),"utf8"),/node:|process\.|next\/|readFile|writeFile|@earendil/);
 assert.deepEqual(taskSupervisionTarget("tasks/bot%3At/supervisor"),{route:"tasks/[id]/supervisor",params:{id:"bot:t"}});
 assert.equal(taskSupervisionTarget("tasks/%GG/subagents"),null);assert.equal(taskSupervisionTarget("tasks/t/title"),null);
 assert.equal(taskSupervisionTarget("tasks/%252F/subagents").params.id,"%2F");assert.equal(jsonBusinessBodyLimit("tasks/t/supervisor"),4096);
 assert.equal(jsonBusinessCommand("tasks/t/supervisor","POST"),true);assert.equal(jsonBusinessCommand("tasks/t/subagents","GET"),false);
});
test("child projection preserves authored messages/tools/deep inputs and strips private runtime fields",()=>{
 const dto=publicSubagentRun(run);assert.ok(dto);assert.ok(!JSON.stringify(dto).includes("PRIVATE"));assert.deepEqual(dto.messages[0].parts[1].state.input,{userAuthored:{nested:[1,"日本語"]}});
 assert.ok(publicJsonBusinessResult("tasks/t/subagents",{status:200,headers:{"set-cookie":"PRIVATE"},body:{runs:[run],token:"PRIVATE"}}));
 assert.deepEqual(publicTaskSupervisionBody("tasks/[id]/subagents",{runs:[]},200),{runs:[]});
});
test("malformed runs and over-limit response fail closed, never fabricated empty success",()=>{
 for(const bad of [{},{...run,status:"unknown"},{...run,messages:[{}]},{...run,startedAtMs:Infinity},{...run,index:"0"}])assert.equal(publicSubagentRun(bad),null);
 assert.equal(publicTaskSupervisionBody("tasks/[id]/subagents",{runs:Array(9).fill(run)},200),null);
 assert.equal(publicTaskSupervisionBody("tasks/[id]/subagents",{runs:[{}]},200),null);
});
test("supervisor result retains ownership summary/partial receipt without arbitrary SDK content",()=>{
 const dto=publicTaskSupervisionBody("tasks/[id]/supervisor",{task:{id:"t",status:"working",supervisorBotId:"b",token:"PRIVATE"},operation:{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",execution:"unknown",token:"PRIVATE"}},200);
 assert.equal(dto.task.supervisorBotId,"b");assert.ok(!JSON.stringify(dto).includes("PRIVATE"));
 assert.equal(publicTaskSupervisionBody("tasks/[id]/supervisor",{task:{id:"t"}},200),null);
 assert.deepEqual(publicTaskSupervisionBody("tasks/[id]/subagents",{error:"refused",token:"PRIVATE"},404),{error:"refused"});
});
