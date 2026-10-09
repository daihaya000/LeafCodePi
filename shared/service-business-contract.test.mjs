import test from "node:test";
import assert from "node:assert/strict";
import { publicServiceBusinessBody, serviceBusinessTarget } from "./service-business-contract.mjs";
import { jsonBusinessCommand, jsonBusinessMutates, jsonBusinessBodyLimit, jsonBusinessTimeout, publicJsonBusinessResult } from "./json-business-contract.mjs";
const id = "11111111-0123-4321-abcd-eeeeeeeeeeee";
test("Explorer metadata validates IDs, declassifies only stored path plus safe loopback controller, and never commands", () => {
  assert.deepEqual(serviceBusinessTarget("tasks/bot%3Ab/explorer"), {route:"tasks/[id]/explorer",params:{id:"bot:b"}});
  for (const id of ["a%2Fb", "a%5Cb", "..", "%00", "%xx"]) assert.equal(serviceBusinessTarget(`projects/${id}/explorer`), null);
  const good={path:"C:\\work",controlUrl:"http://127.0.0.1:18775",token:"PRIVATE"};
  assert.deepEqual(publicServiceBusinessBody("projects/[id]/explorer",good,200),{path:good.path,controlUrl:good.controlUrl});
  for(const controlUrl of ["https://public.example", "http://user:PRIVATE@127.0.0.1", "http://127.0.0.1/?token=PRIVATE", "http://127.0.0.1/private"]) assert.equal(publicServiceBusinessBody("projects/[id]/explorer",{...good,controlUrl},200),null);
  assert.equal(jsonBusinessCommand("projects/p/explorer","GET"),false);
});
test("service verbs, bounds, timeouts and effect classification are explicit", () => {
  assert.equal(jsonBusinessCommand("link-preview", "POST"), false); assert.equal(jsonBusinessMutates("link-preview", "POST"), false);
  assert.equal(jsonBusinessCommand("translation/reasoning", "POST"), true); assert.equal(jsonBusinessMutates("translation/reasoning", "POST"), true);
  assert.equal(jsonBusinessBodyLimit("link-preview", "POST"), 32768); assert.equal(jsonBusinessBodyLimit("translation/reasoning", "POST"), 65536);
  assert.equal(jsonBusinessTimeout("translation/reasoning"), 70000);
});
test("stored task view removes nested private capabilities and preserves archive/Bot fields", () => {
  assert.deepEqual(publicServiceBusinessBody("backend/tasks", { source:"backend",tasks:[{id:"t",status:"archived",kind:"bot",token:"PRIVATE",responseModel:{providerID:"p",modelID:"m",token:"PRIVATE"}}],token:"PRIVATE" },200), {source:"backend",tasks:[{id:"t",status:"archived",kind:"bot",responseModel:{providerID:"p",modelID:"m"}}]});
  for(const value of [{source:"web",tasks:[]},{source:"backend",tasks:[{}]}]) assert.equal(publicServiceBusinessBody("backend/tasks",value,200),null);
});
test("preview DTO only exposes bounded metadata and opaque registered image IDs", () => {
  const value={url:"https://example.com/",title:"日本語",image:"/api/link-preview/image?id="+"a".repeat(32),sourceUrl:"PRIVATE"};
  assert.deepEqual(publicServiceBusinessBody("link-preview",value,200),{url:value.url,title:value.title,image:value.image});
  for(const patch of [{image:"https://private/image"},{url:"https://user:secret@example.com"},{title:"x".repeat(201)},{image:"/api/link-preview/image?id="+"a".repeat(32)+"&url=secret"}]) assert.equal(publicServiceBusinessBody("link-preview",{...value,...patch},200),null);
});
test("image wire is canonical bounded base64/raster-only and excludes source URLs", () => {
  const valid={image:{contentType:"image/png",base64:"iVBORw0KGgo=",url:"PRIVATE"}};
  assert.equal(serviceBusinessTarget("link-preview/image"), null);
  assert.equal(publicServiceBusinessBody("link-preview/image",valid,200), null);
  for(const image of [{contentType:"image/svg+xml",base64:"AQID"},{contentType:"image/png",base64:"AR=="},{contentType:"image/png",base64:""},{contentType:"image/png",base64:"A".repeat(4*Math.ceil(2*1024*1024/3)+4)}]) assert.equal(publicServiceBusinessBody("link-preview/image",{image},200),null);
});
test("translation batches/boolean alignment/complete receipts are deeply validated", () => {
  const good={translations:["日本語"],fallbacks:[false],overridden:[true],operation:{id,execution:"complete",text:"PRIVATE"},token:"PRIVATE"};
  assert.deepEqual(publicServiceBusinessBody("translation/reasoning",good,200),{translations:["日本語"],fallbacks:[false],overridden:[true],operation:{id,execution:"complete"}});
  for(const patch of [{translations:[]},{translations:[1]},{fallbacks:[false,true]},{overridden:[0]},{operation:{id,execution:"unknown"}},{translations:["x".repeat(64001)]}]) assert.equal(publicServiceBusinessBody("translation/reasoning",{...good,...patch},200),null);
  assert.deepEqual(publicJsonBusinessResult("translation/reasoning",{status:503,body:{error:"Unavailable",operation:{id,execution:"unknown"},token:"PRIVATE"},headers:{"set-cookie":"PRIVATE"}},"POST"),{status:503,headers:{},body:{error:"Unavailable",operation:{id,execution:"unknown"}}});
});
