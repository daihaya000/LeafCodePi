import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createPermissionBridge, createQuestionBridge, WEBUI_PERMISSION_HANDLER_KEY, WEBUI_QUESTION_HANDLER_KEY,
} from "./webui-bridge.mjs";

const permissionInput = { sessionId: "session", command: "edit", labels: ["write"], message: "Allow?" };
const questionInput = { sessionId: "session", questions: [{ question: "Which?", options: [{ label: "A" }] }] };

test("construction and unregistered requests are inert and return null", async () => {
  const host = {};
  const permissions = createPermissionBridge({ host, uuid: () => { throw new Error("no id without a handler"); } });
  const questions = createQuestionBridge({ host, uuid: () => { throw new Error("no id without a handler"); } });
  assert.deepEqual(Object.keys(host), []);
  assert.equal(await permissions.requestWebUiPermission(permissionInput), null);
  assert.equal(await questions.requestWebUiQuestion(questionInput), null);
  assert.deepEqual(Object.keys(host), []);
});

test("permission requests use only the global slot, generated id and unchanged payload", async () => {
  const host = {};
  const seen = [];
  const first = createPermissionBridge({ host, uuid: () => "id-1" });
  const second = createPermissionBridge({ host, uuid: () => "id-2" });
  first.registerWebUiPermissionHandler(async (request) => { seen.push(request); return request.id === "id-2"; });
  assert.equal(typeof host[WEBUI_PERMISSION_HANDLER_KEY], "function");
  assert.equal(await second.requestWebUiPermission({ ...permissionInput, ignored: "not forwarded" }), true);
  assert.deepEqual(seen, [{ id: "id-2", ...permissionInput }]);
  assert.equal(await first.requestWebUiPermission({ ...permissionInput, sessionId: "" }), null);
  assert.equal(seen.length, 1);
  second.registerWebUiPermissionHandler(null);
  assert.equal(host[WEBUI_PERMISSION_HANDLER_KEY], null);
  assert.equal(await first.requestWebUiPermission(permissionInput), null);
});

test("question requests preserve payload, empty session behaviour and null unregistering", async () => {
  const host = {};
  const seen = [];
  const bridge = createQuestionBridge({ host, uuid: () => "q-1" });
  bridge.registerWebUiQuestionHandler(async (request) => { seen.push(request); return { answers: [["A"]] }; });
  assert.deepEqual(await bridge.requestWebUiQuestion({ ...questionInput, sessionId: "" }), { answers: [["A"]] });
  assert.deepEqual(seen, [{ id: "q-1", sessionId: "", questions: questionInput.questions }]);
  bridge.registerWebUiQuestionHandler(null);
  assert.equal(host[WEBUI_QUESTION_HANDLER_KEY], null);
  assert.equal(await bridge.requestWebUiQuestion(questionInput), null);
});

test("handler failures and refusals remain visible to the caller", async () => {
  const host = {};
  const permissions = createPermissionBridge({ host });
  const questions = createQuestionBridge({ host });
  permissions.registerWebUiPermissionHandler(async () => false);
  questions.registerWebUiQuestionHandler(async () => { throw new Error("prompt service failed"); });
  assert.equal(await permissions.requestWebUiPermission(permissionInput), false);
  await assert.rejects(questions.requestWebUiQuestion(questionInput), /prompt service failed/);
});

test("default UUIDs are unique and independent buses do not share handlers", async () => {
  const ids = [];
  const one = createPermissionBridge({ host: {} });
  const two = createPermissionBridge({ host: {} });
  one.registerWebUiPermissionHandler(async (request) => { ids.push(request.id); return true; });
  await one.requestWebUiPermission(permissionInput);
  await one.requestWebUiPermission(permissionInput);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(id)));
  assert.equal(await two.requestWebUiPermission(permissionInput), null);
});

test("global keys stay identical to the extension-side bridge copies", () => {
  const permissionSource = readFileSync(new URL("../../extensions/leafcode-permission-gate/webui-bridge.ts", import.meta.url), "utf8");
  const questionSource = readFileSync(new URL("../../extensions/leafcode-question/webui-question-bridge.ts", import.meta.url), "utf8");
  assert.ok(permissionSource.includes(`const GLOBAL_KEY = "${WEBUI_PERMISSION_HANDLER_KEY}"`));
  assert.ok(questionSource.includes(`const GLOBAL_KEY = "${WEBUI_QUESTION_HANDLER_KEY}"`));
  // The extension copies keep their own request-shape contract with the same fields.
  assert.match(permissionSource, /id: randomUUID\(\),\s+sessionId: input\.sessionId,\s+command: input\.command,\s+labels: input\.labels,\s+message: input\.message/);
  assert.match(questionSource, /id: crypto\.randomUUID\(\),\s+sessionId: input\.sessionId,\s+questions: input\.questions/);
});

test("plain Node uses the default globalThis slot without Web imports", () => {
  const moduleUrl = new URL("./webui-bridge.mjs", import.meta.url).href;
  const code = `
    import { createPermissionBridge } from ${JSON.stringify(moduleUrl)};
    const one = createPermissionBridge();
    const two = createPermissionBridge();
    one.registerWebUiPermissionHandler(async (request) => request.command === "edit");
    console.log(JSON.stringify({ approved: await two.requestWebUiPermission({ sessionId: "s", command: "edit", labels: [], message: "" }) }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), { approved: true });
});
