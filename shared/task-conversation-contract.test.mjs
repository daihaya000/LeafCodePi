import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TASK_CONVERSATION_ROUTES, taskConversationTarget, taskConversationBodyLimit, publicTaskConversationBody } from "./task-conversation-contract.mjs";
import { JSON_BUSINESS_ROUTES, jsonBusinessTarget, jsonBusinessCommand, jsonBusinessMutates, jsonBusinessBodyLimit, publicJsonBusinessResult } from "./json-business-contract.mjs";
const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
test("all conversation routes are commands; targets decode once and body bounds preserve attachment/answer budgets",()=>{
 for(const [route,methods] of Object.entries(TASK_CONVERSATION_ROUTES)){const path=route.replace("[id]","bot%3Afixture");assert.deepEqual(JSON_BUSINESS_ROUTES[route],methods);assert.equal(taskConversationTarget(path).params.id,"bot:fixture");assert.equal(jsonBusinessTarget(path).route,route);assert.equal(jsonBusinessCommand(path,"POST"),true);assert.equal(jsonBusinessMutates(path,"POST"),true);assert.equal(jsonBusinessBodyLimit(path),taskConversationBodyLimit(path));}
 assert.equal(taskConversationBodyLimit("tasks/t/prompt"),18*1024*1024);assert.equal(taskConversationBodyLimit("tasks/t/permission"),4096);assert.equal(taskConversationBodyLimit("tasks/t/question"),16384);
 assert.equal(taskConversationTarget("tasks/%252F/prompt").params.id,"%2F");assert.equal(taskConversationTarget("tasks/%/prompt"),null);assert.equal(taskConversationTarget("tasks/t/prompt/extra"),null);
});
test("prompt projects Task, Auto decision/escalation and operation deeply without echoing privileged input or secrets",()=>{
 const reply=publicJsonBusinessResult("tasks/t/prompt",{status:200,headers:{"set-cookie":"PRIVATE",etag:"e"},body:{task:{id:"t",status:"working",credentials:"PRIVATE",responseModel:{providerID:"p",modelID:"m",headers:{secret:"PRIVATE"}}},autoDecision:{providerID:"p",modelID:"m",variant:"high",mode:"cost",escalation:{providerID:"p",modelID:"b",token:"PRIVATE"},token:"PRIVATE"},operation:{id,execution:"complete",answer:"PRIVATE"},prompt:"PRIVATE",fromBot:true}});
 assert.equal(reply.body.task.responseModel.modelID,"m");assert.equal(reply.body.autoDecision.escalation.modelID,"b");assert.deepEqual(reply.body.operation,{id,execution:"complete"});assert.deepEqual(reply.headers,{etag:"e"});assert.ok(!JSON.stringify(reply).includes("PRIVATE"));assert.equal(reply.body.fromBot,undefined);
});
test("invalid success, private-only fields and malformed decisions/ACK are rejected",()=>{
 for(const body of [{},{ok:true},{task:{id:"t"}},{task:{id:"t",status:"idle"},autoDecision:{token:"PRIVATE"}},{task:{id:"t",status:"idle"},operation:{id,execution:"maybe"}}])assert.equal(publicTaskConversationBody("tasks/[id]/prompt",body,200),null);
 for(const route of ["tasks/[id]/permission","tasks/[id]/question"]){assert.equal(publicTaskConversationBody(route,{ok:false},200),null);assert.deepEqual(publicTaskConversationBody(route,{ok:true,answer:"PRIVATE",approved:true,operation:{id,execution:"complete"}},200),{ok:true,operation:{id,execution:"complete"}});}
});
test("refusal/unknown outcomes retain public uncertainty only and contract has no SDK/FS/singleton dependency",()=>{
 for(const route of Object.keys(TASK_CONVERSATION_ROUTES))assert.deepEqual(publicTaskConversationBody(route,{error:"expired",operation:{id,execution:"unknown"},answers:[["PRIVATE"]]},503),{error:"expired",operation:{id,execution:"unknown"}});
 for(const name of ["task-conversation-contract.mjs","task-collection-contract.mjs"])assert.doesNotMatch(readFileSync(new URL(name,import.meta.url),"utf8"),/node:|next\/|process\.|readFile|writeFile|@earendil/);
});
