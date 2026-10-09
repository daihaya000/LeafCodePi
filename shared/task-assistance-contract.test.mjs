import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taskAssistanceTarget, taskAssistanceBodyLimit, taskAssistanceCancelsOnDisconnect, publicTaskAssistanceBody } from "./task-assistance-contract.mjs";
import { jsonBusinessBodyLimit, jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
const task={id:"t",status:"idle",title:"authored 日本語",titleAutoUpdate:false,responseModel:{providerID:"p",modelID:"m",token:"PRIVATE"},token:"PRIVATE"};
const model={providerID:"p",modelID:"m",accountId:"a",token:"PRIVATE",headers:{secret:"PRIVATE"}};
const body={task,title:"authored",label:"l",source:"direct",answer:"authored",question:"question",snapshotAt:1,working:true,advice:"advice",suggestion:"next",suggestions:["next"],model,token:"PRIVATE"};
test("assistance contract stays pure and target IDs decode once",()=>{
 assert.doesNotMatch(readFileSync(new URL("./task-assistance-contract.mjs",import.meta.url),"utf8"),/node:|process\.|next\/|readFile|writeFile|@earendil/);
 for(const action of ["progress","next-action","title","permission/advice"])assert.deepEqual(taskAssistanceTarget("tasks/bot%3At/"+action),{route:"tasks/[id]/"+action,params:{id:"bot:t"}});
 assert.equal(taskAssistanceTarget("tasks/t/supervisor"),null);assert.equal(taskAssistanceTarget("tasks/%GG/title"),null);
 assert.equal(taskAssistanceTarget("tasks/%252F/title").params.id,"%2F");
});
test("raw UTF-16 compatibility budgets and only progress disconnects cancel",()=>{
 for(const [action,limit] of [["progress",32000],["next-action",320000],["title",32000],["permission/advice",4096]]){const path="tasks/t/"+action;assert.equal(taskAssistanceBodyLimit(path),limit);assert.equal(jsonBusinessBodyLimit(path),limit);assert.equal(jsonBusinessCommand(path,"POST"),true);assert.equal(taskAssistanceCancelsOnDisconnect(path),action==="progress");}
 assert.equal(jsonBusinessCommand("tasks/t/title","PATCH"),true);
 assert.equal(taskAssistanceCancelsOnDisconnect("tasks/t/compact"),false);
});
for(const action of ["progress","next-action","title","permission/advice"])test(action+" deep projection retains authored UI and strips private SDK/model",()=>{
 const route="tasks/[id]/"+action,dto=publicTaskAssistanceBody(route,body,200,"POST");
 assert.ok(dto);assert.ok(!JSON.stringify(dto).includes("PRIVATE"));assert.deepEqual(dto.model,{providerID:"p",modelID:"m",accountId:"a"});assert.ok(!("headers" in dto.model));
 assert.ok(publicJsonBusinessResult("tasks/t/"+action,{status:200,body,headers:{"set-cookie":"PRIVATE"}}, "POST"));assert.equal(publicTaskAssistanceBody(route,{...body,error:"bad"},200),null);
 assert.equal(publicTaskAssistanceBody(route,{...body,model:{providerID:"p"}},200),null);
 assert.equal(publicTaskAssistanceBody(route,{...body,operation:{id:"bad",execution:"complete"}},200),null);
});
test("title label-only result can have no generated label and PATCH needs observed title",()=>{
 assert.deepEqual(publicTaskAssistanceBody("tasks/[id]/title",{task},200,"POST"),{task:{id:"t",status:"idle",title:"authored 日本語",titleAutoUpdate:false,responseModel:{providerID:"p",modelID:"m"}}});
 assert.equal(publicTaskAssistanceBody("tasks/[id]/title",{task},200,"PATCH"),null);
 assert.equal(publicTaskAssistanceBody("tasks/[id]/title",{title:"t",task:null},200),null);
});
test("malformed required assistance fields refuse success; errors remain bounded projections",()=>{
 for(const action of ["progress","next-action","permission/advice"])assert.equal(publicTaskAssistanceBody("tasks/[id]/"+action,{},200),null);
 assert.equal(publicTaskAssistanceBody("tasks/[id]/next-action",{...body,suggestions:[{}]},200),null);
 assert.equal(publicTaskAssistanceBody("tasks/[id]/progress",{...body,snapshotAt:Infinity},200),null);
 assert.deepEqual(publicTaskAssistanceBody("tasks/[id]/progress",{error:"refused",token:"PRIVATE"},422),{error:"refused"});
});
