import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TASK_COMPACTION_BODY_LIMIT, taskCompactionTarget, publicTaskCompactionBody } from "./task-compaction-contract.mjs";
import { jsonBusinessBodyLimit, jsonBusinessTimeout, jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
for(const action of ["compact","compact/abort"]) test(`${action} bounds and deadlines preserve start vs abort semantics`,()=>{
 const path=`tasks/bot%3At/${action}`,route=`tasks/[id]/${action}`;
 assert.deepEqual(taskCompactionTarget(path),{route,params:{id:"bot:t"}});
 assert.equal(jsonBusinessBodyLimit(path),action==="compact"?TASK_COMPACTION_BODY_LIMIT:4096);
 assert.equal(jsonBusinessTimeout(path),action==="compact"?300000:10000);assert.equal(jsonBusinessCommand(path,"POST"),true);
 assert.equal(taskCompactionTarget(`tasks/%252F/${action}`).params.id,"%2F");assert.equal(taskCompactionTarget(`tasks/%FF/${action}`),null);
 assert.equal(taskCompactionTarget(`tasks/a/b/${action}`),null);
});
test("maximum valid Unicode/control focus fits the byte bound; not just ASCII compatibility",()=>{
 for(const char of ["漢","😀","\u0000","\\",'"'])assert.ok(new TextEncoder().encode(JSON.stringify({customInstructions:char.repeat(32000)})).byteLength<=TASK_COMPACTION_BODY_LIMIT);
});
test("deep detail and cancellation status are retained, private SDK fields are removed, malformed success rejected",()=>{
 const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
 const input={task:{id:"t",status:"idle",isStreaming:false,isCompacting:true,messages:[{id:"c",role:"compaction",createdAt:1,parts:[{id:"p",type:"text",text:"authored summary",token:"PRIVATE"}]}],token:"PRIVATE"},operation:{id,execution:"complete",token:"PRIVATE"},token:"PRIVATE"};
 for(const route of ["tasks/[id]/compact","tasks/[id]/compact/abort"]){
  const result=publicTaskCompactionBody(route,input,200);assert.equal(result.task.isCompacting,true);assert.equal(result.task.messages[0].parts[0].text,"authored summary");assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(publicTaskCompactionBody(route,{task:{id:"t",status:"idle"}},200),null);
  assert.equal(publicTaskCompactionBody(route,{...input,error:"bad success"},200),null);
  assert.deepEqual(publicJsonBusinessResult(route,{status:400,headers:{"set-cookie":"PRIVATE"},body:{error:"cancelled",operation:{id,execution:"complete"},token:"PRIVATE"}}),{status:400,headers:{},body:{error:"cancelled",operation:{id,execution:"complete"}}});
 }
 assert.doesNotMatch(readFileSync(new URL("./task-compaction-contract.mjs",import.meta.url),"utf8"),/node:|next\/|process\.|@earendil|readFile|writeFile/);
});
