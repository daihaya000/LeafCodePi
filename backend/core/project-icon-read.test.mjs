import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppStore } from "./app-store.mjs";
test("owner-only project icon reads immutable primitives without cloning and follow atomic store replacement",t=>{
 const root=mkdtempSync(join(tmpdir(),"leafcode-icon-read-")),path=join(root,"store.json"),previous=process.env.LEAFCODE_PI_PROCESS_ROLE;
 t.after(()=>{if(previous===undefined)delete process.env.LEAFCODE_PI_PROCESS_ROLE;else process.env.LEAFCODE_PI_PROCESS_ROLE=previous;rmSync(root,{recursive:true,force:true});});
 process.env.LEAFCODE_PI_PROCESS_ROLE="backend";
 const save=(value,file=path)=>writeFileSync(file,JSON.stringify({version:1,projects:[{id:"p",name:"fixture",rootPath:root,icon:value}],tasks:[]}));
 save("data:image/png;base64,"+"A".repeat(2*1024*1024));
 const store=new AppStore({storePath:()=>path,noProjectSessionDir:()=>root,samePath:(a,b)=>a===b,noProjectName:"fixture"});
 const clone=globalThis.structuredClone;globalThis.structuredClone=()=>{throw new Error("cloned");};
 try{assert.equal(store.getProjectIcon("p").length,2*1024*1024+22);assert.equal(store.getProjectIcon("missing"),undefined);assert.throws(()=>store.getProject("p"),/cloned/);}
 finally{globalThis.structuredClone=clone;}
 save("replacement",path+".new");renameSync(path+".new",path);assert.equal(store.getProjectIcon("p"),"replacement");
 save(null,path+".new");renameSync(path+".new",path);assert.equal(store.getProjectIcon("p"),undefined);
 process.env.LEAFCODE_PI_PROCESS_ROLE="next";assert.throws(()=>store.getProjectIcon("p"),/owned by Backend/);
});
