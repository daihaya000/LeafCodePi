import test from "node:test";import assert from "node:assert/strict";
import { BROWSE_ROUTES,publicBrowseBody } from "./browse-contract.mjs";
import { JSON_BUSINESS_ROUTES,jsonBusinessBodyLimit,jsonBusinessMutates,jsonBusinessCommand,publicJsonBusinessResult } from "./json-business-contract.mjs";
import {publicHostFolderBody}from"./host-folder-contract.mjs";
test("two Backend routes/three reads; Host-only folder dialog POST never enters Backend",()=>{
 assert.deepEqual(BROWSE_ROUTES,{"browse/dirs":["GET"],"browse/icon":["GET","POST"]});
 for(const [route,methods]of Object.entries(BROWSE_ROUTES)){assert.deepEqual(JSON_BUSINESS_ROUTES[route],methods);for(const method of methods){assert.equal(jsonBusinessMutates(route,method),false);assert.equal(jsonBusinessCommand(route,method),false);assert.equal(jsonBusinessBodyLimit(route,method),256*1024);}}
});
test("deep authorized path/entry/icon DTO retains content, strips private fields, sanitizes listing failures",()=>{
 const entries=[{name:"日本語",path:"authorized/path",kind:"home",token:"PRIVATE"}];
 const result=publicBrowseBody("browse/dirs",{path:"authorized",parent:null,quickAccess:entries,drives:[],entries,command:"PRIVATE",error:"PRIVATE errno"},200,"GET");
 assert.equal(result.entries[0].name,"日本語");assert.ok(!JSON.stringify(result).includes("PRIVATE"));
 assert.deepEqual(publicBrowseBody("browse/icon",{icon:"data:image/x-icon;base64,AA==",name:"fixture.ico",path:"PRIVATE"},200,"POST"),{icon:"data:image/x-icon;base64,AA==",name:"fixture.ico"});
 assert.equal(publicBrowseBody("browse/icon",{icon:"file://PRIVATE",name:"fixture"},200,"POST"),null);
 assert.equal(publicBrowseBody("browse/dirs",{path:"authorized",parent:null,quickAccess:[],drives:[],entries:[{}]},200,"GET"),null);
 assert.equal(publicJsonBusinessResult("browse/icon",{status:200,headers:{},body:{icon:"data:image/png;base64,"+"A".repeat(3000101),name:"x"}},"POST"),null);
});
test("Host response has only selection/cancelled/error; private errors are unknown and malformed success refused",()=>{
 assert.deepEqual(publicHostFolderBody({path:"日本語",token:"PRIVATE"},200),{path:"日本語"});
 assert.deepEqual(publicHostFolderBody({cancelled:true,command:"PRIVATE"},200),{cancelled:true});
 assert.deepEqual(publicHostFolderBody({error:"PRIVATE command"},503),{error:"フォルダ選択の結果を確認できません",execution:"unknown"});
 assert.equal(publicHostFolderBody({path:123},200),null);
 assert.deepEqual(publicHostFolderBody({error:"unsupported"},501),{error:"フォルダ選択にHostが未対応です",execution:"not-started"});
});
