import test from "node:test";
import assert from "node:assert/strict";
import { publicTaskCollectionBody, publicTaskSummary, taskCollectionTarget, TASK_COLLECTION_BODY_LIMIT } from "./task-collection-contract.mjs";
import { jsonBusinessTarget, jsonBusinessCommand, jsonBusinessBodyLimit, publicJsonBusinessResult } from "./json-business-contract.mjs";
test("task collection transport preserves aggregate image/file/prompt room and command ownership", () => {
  assert.equal(jsonBusinessTarget("tasks").route,"tasks"); assert.equal(taskCollectionTarget("tasks/x"),null); assert.equal(jsonBusinessTarget("tasks/x").route,"tasks/[id]"); assert.equal(jsonBusinessCommand("tasks","POST"),true); assert.equal(jsonBusinessCommand("tasks","GET"),false);
  assert.equal(jsonBusinessBodyLimit("tasks"),TASK_COLLECTION_BODY_LIMIT); assert.ok(TASK_COLLECTION_BODY_LIMIT > 16*1024*1024+256000);
});
test("task rows deeply project metadata and remove SDK, credential and initial prompt payloads", () => {
  const projected=publicTaskSummary({id:"t",status:"idle",projectId:null,agent:null,botId:null,sessionFile:null,accountIdExplicit:false,
    todoProgress:{completed:1,total:2,token:"PRIVATE"},goalLoopSummary:{status:"paused",maxTurns:0,turnCount:1,initialImages:"PRIVATE"},
    responseModel:{providerID:"p",modelID:"m",credentials:"PRIVATE"},session:{apiKey:"PRIVATE"},auth:"PRIVATE",prompt:"PRIVATE"});
  assert.ok(projected); assert.equal(projected.sessionFile,null); assert.equal(projected.todoProgress.completed,1); assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
  assert.equal(publicTaskSummary({id:"t",status:"bad"}),null); assert.equal(publicTaskSummary({id:"t",status:"idle",todoProgress:{completed:"one",total:2}}),null);
});
test("attention, Auto route/escalation and destructive command ACK retain only their public DTOs", () => {
  const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const result=publicTaskCollectionBody({task:{id:"t",status:"working"},autoDecision:{providerID:"p",modelID:"m",tier:"light",mode:"balanced",reason:"r",variant:"",usedPreset:false,escalation:{providerID:"p2",modelID:"m2",token:"PRIVATE"},token:"PRIVATE"},operation:{id,execution:"complete",prompt:"PRIVATE"}},200);
  assert.ok(result); assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.equal(result.autoDecision.escalation.modelID,"m2");
  assert.deepEqual(publicTaskCollectionBody({attention:[{taskId:"t",title:"T",kinds:["permission","question"],originTaskId:"b",questionRequest:{token:"PRIVATE"}}]},200),{attention:[{taskId:"t",title:"T",originTaskId:"b",kinds:["permission","question"]}]});
  assert.equal(publicTaskCollectionBody({attention:[{taskId:"t",title:"T",kinds:["unknown"]}]},200),null);
  assert.deepEqual(publicTaskCollectionBody({ok:true,removed:2,operation:{id,execution:"complete"},mutation:{saved:true}},200),{ok:true,removed:2,operation:{id,execution:"complete"}});
  assert.deepEqual(publicJsonBusinessResult("tasks",{status:304,headers:{etag:"e","set-cookie":"PRIVATE"},body:null}),{status:304,headers:{etag:"e"},body:null});
});
