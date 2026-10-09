import test,{beforeEach,afterEach} from"node:test";import assert from"node:assert/strict";import{selectProjectFolder}from"./select-folder.js";
let role;beforeEach(()=>{role=process.env.LEAFCODE_PI_PROCESS_ROLE;process.env.LEAFCODE_PI_PROCESS_ROLE="host";});afterEach(()=>{if(role===undefined)delete process.env.LEAFCODE_PI_PROCESS_ROLE;else process.env.LEAFCODE_PI_PROCESS_ROLE=role;});
test("fixed Host-only encoded dialog uses UTF-8, selected directory and cleanup; no caller code",async()=>{
 let seen;const result=await selectProjectFolder({platform:"win32",exec:async(...args)=>{seen=args;return{stdout:" C:\\日本語\\project "};},statFile:async()=>({isDirectory:()=>true})});
 assert.deepEqual(result,{path:"C:\\日本語\\project"});assert.equal(seen[0],"powershell.exe");const script=Buffer.from(seen[1][3],"base64").toString("utf16le");assert.match(script,/FolderBrowserDialog/);assert.match(script,/finally/);assert.equal(seen[2].windowsHide,false);assert.equal(seen[2].timeout,120000);
});
test("cancel/unsupported/not-directory/private failure produce bounded honest results",async()=>{
 assert.deepEqual(await selectProjectFolder({platform:"win32",exec:async()=>({stdout:""})}),{cancelled:true});
 await assert.rejects(selectProjectFolder({platform:"linux"}),e=>e.status===400);
 await assert.rejects(selectProjectFolder({platform:"win32",exec:async()=>({stdout:"selected"}),statFile:async()=>({isDirectory:()=>false})}),e=>e.status===400);
 await assert.rejects(selectProjectFolder({platform:"win32",exec:async()=>{throw new Error("PRIVATE command");}}),e=>e.status===503&&!e.message.includes("PRIVATE"));
});
test("Next and Backend are denied before any native operation",async()=>{
 const before=process.env.LEAFCODE_PI_PROCESS_ROLE;try{for(const role of["next","backend"]){process.env.LEAFCODE_PI_PROCESS_ROLE=role;let called=false;await assert.rejects(selectProjectFolder({platform:"win32",exec:async()=>{called=true;return{stdout:""};}}),/owned by Host/);assert.equal(called,false);}}finally{if(before===undefined)delete process.env.LEAFCODE_PI_PROCESS_ROLE;else process.env.LEAFCODE_PI_PROCESS_ROLE=before;}
});
