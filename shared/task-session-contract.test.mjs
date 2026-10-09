import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TASK_SESSION_ROUTES, taskSessionTarget, publicTaskSessionBody } from "./task-session-contract.mjs";
import { jsonBusinessBodyLimit, jsonBusinessCommand, publicJsonBusinessResult } from "./json-business-contract.mjs";
const task = { id: "t", status: "idle", token: "PRIVATE" };
const detail = { ...task, isStreaming: false, messages: [{ id: "u", role: "user", createdAt: 1, parts: [{ id: "p", type: "text", text: "authored", token: "PRIVATE" }], token: "PRIVATE" }] };
for (const action of ["fork", "revert", "unrevert", "promote"]) test(`${action} is bounded, matched once and a command`, () => {
  const path = `tasks/bot%3At/${action}`, route = `tasks/[id]/${action}`;
  assert.deepEqual(taskSessionTarget(path), { route, params: { id: "bot:t" } });
  assert.deepEqual(TASK_SESSION_ROUTES[route], ["POST"]); assert.equal(jsonBusinessBodyLimit(path),4096); assert.equal(jsonBusinessCommand(path,"POST"),true);
  assert.equal(taskSessionTarget(`tasks/%252F/${action}`).params.id,"%2F"); assert.equal(taskSessionTarget(`tasks/%FF/${action}`),null);
  assert.equal(taskSessionTarget(`tasks/a/b/${action}`),null);
});
test("pure DTOs retain drafts, authored transcript and partial promotion warning; remove nested private fields", () => {
  for(const action of ["fork","revert"]) {
    const value={task:action==="fork"?task:detail,text:"restored",images:[{uri:"data:image/png;base64,YQ==",mime:"image/png",name:"x",token:"PRIVATE"}],files:[{uri:"data:text/plain;base64,YQ==",mime:"text/plain",token:"PRIVATE"}],token:"PRIVATE"};
    const projected=publicTaskSessionBody(`tasks/[id]/${action}`,value,200);
    assert.equal(projected.text,"restored"); assert.equal(projected.files[0].mime,"text/plain"); assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
    assert.equal(publicTaskSessionBody(`tasks/[id]/${action}`,{...value,files:[{}]},200),null);
  }
  assert.equal(publicTaskSessionBody("tasks/[id]/unrevert",{task:detail},200).task.messages[0].parts[0].text,"authored");
  const promoted=publicTaskSessionBody("tasks/[id]/promote",{task,project:{id:"p",name:"P",rootPath:"path",token:"PRIVATE"},warning:"元の削除失敗"},200);
  assert.equal(promoted.warning,"元の削除失敗");assert.ok(!JSON.stringify(promoted).includes("PRIVATE"));
  assert.equal(publicTaskSessionBody("tasks/[id]/promote",{task,project:{}},200),null);
  assert.equal(publicTaskSessionBody("tasks/[id]/unrevert",{task},200),null);
  assert.equal(publicTaskSessionBody("tasks/[id]/fork",{task,text:"",images:[],files:[],error:"false success"},200),null);
  assert.deepEqual(publicJsonBusinessResult("tasks/t/revert",{status:409,body:{error:"busy",token:"PRIVATE"},headers:{"set-cookie":"PRIVATE"}}),{status:409,body:{error:"busy"},headers:{}});
  assert.doesNotMatch(readFileSync(new URL("./task-session-contract.mjs",import.meta.url),"utf8"),/node:|next\/|process\.|@earendil|readFile|writeFile/);
});
