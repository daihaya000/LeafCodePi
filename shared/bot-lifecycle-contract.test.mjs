import assert from "node:assert/strict";
import test from "node:test";
import { BOT_LIFECYCLE_ROUTES, botLifecycleTarget, botLifecycleBodyLimit, validBotLifecycleId, publicBot, publicBotLifecycleBody } from "./bot-lifecycle-contract.mjs";
import { jsonBusinessCommand, publicJsonBusinessResult, jsonBusinessTarget } from "./json-business-contract.mjs";
const id="11111111-0123-4321-abcd-eeeeeeeeeeee";
const bot=()=>({id,name:"日本語",label:"",soul:"user authored PRIVATE text",avatarColor:"#fff",avatarImage:null,model:null,thinkingLevel:"max",permissionMode:"ask",enabled:true,notificationsEnabled:false,codeAutoApprove:false,createdAt:"fixture",updatedAt:"fixture",skills:{mode:"inherit",include:[],exclude:[],token:"PRIVATE"},extraRoots:["C:/owner"],tools:["read"],token:"PRIVATE",sdk:{token:"PRIVATE"}});
test("Bot lifecycle paths/methods/bounds are pure, decode once and exclude sibling business APIs",()=>{
 assert.deepEqual(BOT_LIFECYCLE_ROUTES,{bots:["GET","POST"],"bots/[id]":["GET","PATCH","DELETE"]});
 assert.deepEqual(botLifecycleTarget("bots/"+encodeURIComponent(id)),{route:"bots/[id]",params:{id}});
 for(const path of ["bots/sidebar","bots/events","bots/rooms","bots/rooms/one","bots/one/prompt","bots/%XX"])assert.equal(botLifecycleTarget(path),null);
 assert.equal(botLifecycleTarget("bots/%252F").params.id,"%2F");for(const bad of ["../x","%2F","bot:id","bad-id",id+"a".repeat(129)])assert.equal(validBotLifecycleId(bad),false);
 assert.equal(validBotLifecycleId(id),true);assert.deepEqual(jsonBusinessTarget("bots/"+id),botLifecycleTarget("bots/"+id));
 for(const method of ["GET","POST","PATCH","DELETE"]){assert.equal(botLifecycleBodyLimit("bots/"+id,method),method==="PATCH"?4194304:4096);assert.equal(jsonBusinessCommand("bots/"+id,method),method!=="GET");}
});
test("deep Bot DTO preserves authored config/soul/roots, projects nested skills and refuses malformed success",()=>{
 const source=bot(),out=publicBot(source);assert.equal(out.soul,source.soul);assert.deepEqual(out.skills,{mode:"inherit",include:[],exclude:[]});assert.equal(out.token,undefined);assert.equal(out.sdk,undefined);out.skills.include.push("changed");assert.deepEqual(source.skills.include,[]);
 for(const [key,value] of [["id",2],["enabled","true"],["model",{}],["tools",[{}]],["skills",{mode:"include",include:[2],exclude:[]}],["thinkingLevel","super"],["permissionMode","turbo"],["codeSessionCount",-1],["extraRoots",[2]],["avatarImage",{}]])assert.equal(publicBot({...bot(),[key]:value}),null,key);
 const expanded={...bot(),avatarShape:"leaf",avatarEyeColor:"#000",avatarGlasses:true,avatarMustache:false,avatarImage:"data:image/png;base64,AQ==",ttsVoice:null,intercomEnabled:true,intercomScopeId:"workspace",intercomFanoutEnabled:false,codeSessionTaskId:null,codeSessionCount:2};
 assert.equal(publicBot(expanded).codeSessionCount,2);
 assert.equal(publicBotLifecycleBody("bots",{},200,"GET"),null);assert.equal(publicBotLifecycleBody("bots/[id]",{bot:{id}},200,"PATCH"),null);
 assert.equal(publicBotLifecycleBody("bots/[id]",{ok:false},200,"DELETE"),null);
 assert.deepEqual(publicBotLifecycleBody("bots/[id]",{ok:true,token:"PRIVATE"},200,"DELETE"),{ok:true});
});
test("operation results and errors are explicitly projected; unknown outcomes are not empty success",()=>{
 const operation={id,execution:"unknown",input:"PRIVATE"};assert.deepEqual(publicBotLifecycleBody("bots/[id]",{error:"busy",operation,token:"PRIVATE"},503,"PATCH"),{error:"busy",operation:{id,execution:"unknown"}});
 assert.equal(publicBotLifecycleBody("bots",[2],503,"POST"),null);
 const dto=publicJsonBusinessResult("bots/"+id,{status:200,body:{bot:bot()},headers:{"set-cookie":"PRIVATE",etag:"public"}},"GET");assert.equal(dto.headers["set-cookie"],undefined);assert.equal(dto.body.bot.skills.token,undefined);
 assert.deepEqual(publicJsonBusinessResult("bots",{status:304,headers:{etag:"x"},body:null},"GET"),{status:304,headers:{etag:"x"},body:null});
});
