import test from "node:test";
import assert from "node:assert/strict";
import { taskLifecycleTarget, validTaskLifecycleId, publicTaskDetail, publicTaskLifecycleBody } from "./task-lifecycle-contract.mjs";
import { jsonBusinessCommand, jsonBusinessBodyLimit } from "./json-business-contract.mjs";
const basic={id:"t",status:"idle",isStreaming:false,messages:[]};
test("task targets decode once, retain legacy Bot IDs and bound mutation bodies",()=>{
 assert.equal(taskLifecycleTarget("tasks/bot%3Afixture/abort").params.id,"bot:fixture"); assert.equal(validTaskLifecycleId("bot:fixture"),true);
 for(const path of ["tasks/..%2Ft","tasks/%252F"])assert.equal(validTaskLifecycleId(taskLifecycleTarget(path).params.id),false);
 assert.equal(taskLifecycleTarget("tasks/%zz"),null); assert.equal(taskLifecycleTarget("tasks/t/files"),null); assert.equal(jsonBusinessCommand("tasks/t/abort","POST"),true);assert.equal(jsonBusinessBodyLimit("tasks/t"),4096);
});
test("deep Task detail preserves UI content while removing SDK/credential/diagnostic headers",()=>{
 const input={...basic,token:"PRIVATE",session:{auth:"PRIVATE"},goalLoop:{id:"g",goal:"user goal",acceptance:["verify"],progress:[{time:"now",status:"progress",summary:"owned",token:"PRIVATE"}],auth:"PRIVATE"},
 permissionRequest:{id:"p",sessionId:"s",command:"user command",labels:["x"],message:"approve",auth:"PRIVATE"},
 questionRequest:{id:"q",sessionId:"s",questions:[{question:"choose",options:[{label:"A",token:"PRIVATE"}],multiple:false}],token:"PRIVATE"},
 todos:[{id:"todo",content:"verify",status:"pending",priority:"high",token:"PRIVATE"}],messages:[{id:"m",role:"assistant",createdAt:1,parts:[{id:"p",type:"tool",tool:"echo",callID:"c",state:{status:"completed",input:{userText:"intentional user content",nested:{ok:true}},output:"user result",nestedCalls:[{id:"n",name:"read",status:"ok",token:"PRIVATE"}],auth:"PRIVATE"},auth:"PRIVATE"}],diagnostics:[{type:"transport",error:{message:"diagnostic",stack:"PRIVATE"},details:{phase:"send",headers:{authorization:"PRIVATE"}}}],sdk:{token:"PRIVATE"}}]};
 const projected=publicTaskDetail(input);assert.ok(projected);assert.ok(!JSON.stringify(projected).includes("PRIVATE"));assert.equal(projected.messages[0].parts[0].state.input.nested.ok,true);assert.equal(projected.goalLoop.progress[0].summary,"owned");assert.equal(projected.questionRequest.questions[0].options[0].label,"A");
});
test("message variants, history markers and nullable context/attention remain wire-compatible",()=>{
 const parts=[{id:"a",type:"text",text:"hi"},{id:"b",type:"thinking",text:"thought"},{id:"c",type:"image",url:"data:image/png;base64,YQ==",mime:"image/png",filename:"a.png"},{id:"d",type:"file",name:"a.txt",mime:"text/plain",data:"YQ==",size:1}];
 const projected=publicTaskDetail({...basic,contextUsage:{tokens:null,contextWindow:100,percent:null},goalLoop:null,permissionRequest:null,questionRequest:null,messageHistory:{hasMore:false,nextCursor:null},messages:[{id:"m",role:"user",createdAt:1,parts}]});
 assert.deepEqual(projected.messages[0].parts,parts);assert.equal(projected.messageHistory.nextCursor,null);assert.equal(projected.goalLoop,null);
 assert.equal(publicTaskDetail({...basic,messages:[{id:"m",role:"assistant",createdAt:1,parts:[{id:"p",type:"sdk"}]}]}),null);
});
test("mutation outcomes are execution ACKs, not atomic saves or successful model generation",()=>{
 const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
 assert.deepEqual(publicTaskLifecycleBody("tasks/[id]",{ok:true,operation:{id,execution:"complete"},mutation:{saved:true},token:"PRIVATE"},200),{ok:true,operation:{id,execution:"complete"}});
 assert.deepEqual(publicTaskLifecycleBody("tasks/[id]/abort",{error:"lost",task:{token:"PRIVATE"},operation:{id,execution:"unknown"}},503),{error:"lost",operation:{id,execution:"unknown"}});
});
