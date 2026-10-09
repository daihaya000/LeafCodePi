import assert from "node:assert/strict";
import test from "node:test";
import { BOT_CONVERSATION_ROUTES,botConversationTarget,botConversationBodyLimit,publicBotConversationBody } from "./bot-conversation-contract.mjs";
import { publicJsonBusinessResult,jsonBusinessCommand } from "./json-business-contract.mjs";
const id="11111111-0123-4321-abcd-eeeeeeeeeeee",summary={id:"bot:"+id,status:"working",token:"PRIVATE"},operation={id,execution:"complete",input:"PRIVATE"};
test("Bot conversation resolves only three POST routes, decodes once, preserves image budget and is command-scoped",()=>{
 assert.deepEqual(Object.values(BOT_CONVERSATION_ROUTES),[["POST"],["POST"],["POST"]]);for(const action of ["prompt","abort","revert"]){const path="bots/"+id+"/"+action;assert.deepEqual(botConversationTarget(path),{route:"bots/[id]/"+action,params:{id}});assert.equal(botConversationBodyLimit(path),action==="prompt"?18874368:4096);assert.equal(jsonBusinessCommand(path,"POST"),true);}
 assert.equal(botConversationTarget("bots/%252F/prompt").params.id,"%2F");for(const path of ["bots/one","bots/rooms/one/prompt","bots/one/events","bots/%XX/abort"])assert.equal(botConversationTarget(path),null);
});
test("ordinary/Goal summary retain only authored public outputs and validate successful Goal identity/live state",()=>{
 const send=publicBotConversationBody("bots/[id]/prompt",{task:summary,operation,token:"PRIVATE"},200);assert.deepEqual(send,{task:{id:summary.id,status:"working"},operation:{id,execution:"complete"}});
 const loop={id:"g",sessionId:"s",status:"verifying_completed",goal:"authored 日本語",initialImages:[{type:"image",mimeType:"image/png",data:"authored",token:"PRIVATE"}],progress:[{time:"1",status:"progress",summary:"authored",token:"PRIVATE"}],token:"PRIVATE"};
 const projected=publicBotConversationBody("bots/[id]/prompt",{task:null,loop},200);assert.equal(projected.loop.goal,loop.goal);assert.equal(projected.loop.initialImages[0].token,undefined);assert.equal(projected.loop.progress[0].token,undefined);
 for(const value of [{task:{}},{task:null},{task:summary,loop},{task:null,loop:{status:"queued"}},{task:null,loop:{...loop,status:"paused"}}])assert.equal(publicBotConversationBody("bots/[id]/prompt",value,200),null);
 assert.equal(publicBotConversationBody("bots/[id]/abort",{task:{}},200),null);assert.equal(publicBotConversationBody("bots/[id]/abort",{task:summary,token:"PRIVATE"},200).task.token,undefined);
});
test("revert preserves conversation/attachments/cancel count and strips deep SDK data",()=>{
 const value={task:{...summary,isStreaming:false,messages:[{id:"m",role:"user",createdAt:1,parts:[{id:"p",type:"text",text:"authored 日本語",token:"PRIVATE"}],token:"PRIVATE"}]},text:"draft 日本語",images:[{uri:"data:image/png;base64,AQ==",mime:"image/png",token:"PRIVATE"}],files:[],cancelledCodeRequests:2,operation};
 const out=publicBotConversationBody("bots/[id]/revert",value,200);assert.equal(out.task.messages[0].parts[0].text,"authored 日本語");assert.equal(out.images[0].token,undefined);assert.ok(!JSON.stringify(out).includes("PRIVATE"));
 for(const cancelledCodeRequests of [undefined,-1,1.5,"2"])assert.equal(publicBotConversationBody("bots/[id]/revert",{...value,cancelledCodeRequests},200),null);
 assert.deepEqual(publicBotConversationBody("bots/[id]/revert",{error:"busy",operation:{id,execution:"unknown"},token:"PRIVATE"},503),{error:"busy",operation:{id,execution:"unknown"}});
 assert.equal(publicJsonBusinessResult("bots/"+id+"/prompt",{status:200,body:{task:summary},headers:{"set-cookie":"PRIVATE"}},"POST").body.task.token,undefined);
});
