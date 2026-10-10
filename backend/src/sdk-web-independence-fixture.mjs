// Test-only process: real Backend entry/harness/SDK. Only model/provider input is finite and local.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ModelRuntime, AgentSession } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

const data = resolve(process.env.LEAFCODE_PI_DATA_DIR);
assert.ok(data.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
assert.equal(process.env.LEAFCODE_PI_PROCESS_ROLE, "backend");
assert.equal(typeof process.send, "function", "Fixture requires an isolated IPC parent");
let deniedNetwork = 0;
globalThis.fetch = async () => { deniedNetwork++; throw new Error("Fixture forbids external fetch"); };
const runtime = await import(pathToFileURL(process.env.LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE).href);
const unsubscribe = runtime.subscribeTaskDirty(() => {}); // Initialize the real process-local state.
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "finite-sdk", models: [{ id: "bounded", contextWindow: 32768, maxTokens: 512 }], tokensPerSecond: 12, tokenSize: { min: 1, max: 1 } });
modelRuntime.registerNativeProvider(faux.provider);
globalThis.__leafcodePiHarness.modelRuntime = modelRuntime;
// Provider-discovery is outside this acceptance test. Do not consult real credentials/catalogs.
globalThis.__leafcodePiOptionalProviders = new WeakMap([[modelRuntime, Promise.resolve()]]);
let taskId, originalSession, activeGate = null;
const gates = new Map();
let samples = 0;
const answers = ["SDK第一結果: 日本語の履歴はWeb再起動後も保持される。", "SDK第二結果: Web停止中に完了し、受付済操作を再実行しない。"];
faux.setResponses(answers.map((answer, index) => async () => {
  activeGate = index + 1;
  await new Promise(resolveGate => gates.set(index + 1, resolveGate));
  gates.delete(index + 1);
  activeGate = null;
  return fauxAssistantMessage(answer);
}));
function sample() {
  const live = taskId ? globalThis.__leafcodePiHarness.live.get(taskId) : undefined;
  let lease = null;
  try { lease = JSON.parse(readFileSync(join(data, "task-leases", `${taskId}.json`), "utf8")); } catch {}
  if (live && !originalSession) originalSession = live.session;
  const owner = JSON.parse(readFileSync(join(data, "runtime-owner.json"), "utf8"));
  return { pid: process.pid, sdkLoaded: true, taskId, owner, networkDisabled: true, sessionId: live?.session.sessionId ?? null,
    realAgentSession: live?.session instanceof AgentSession, sameSession: live?.session === originalSession,
    streaming: live?.session.isStreaming ?? false, status: taskId ? runtime.getTask(taskId)?.status : null,
    lease, calls: faux.state.callCount, activeGate, messages: live?.session.messages.length ?? 0,
    liveCount: globalThis.__leafcodePiHarness.live.size, deniedNetwork, sample: ++samples };
}
process.on("message", async message => {
  try {
    if (message?.action === "create") {
      const task = await runtime.createTask({ projectId: null, prompt: "finite SDK probe", model: "finite-sdk::bounded", thinkingLevel: "off", permissionMode: "deny", subagentPermission: "deny" });
      taskId = task.id;
      process.send?.({ reply: message.id, value: { task, ...sample() } });
    } else if (message?.action === "track") {
      assert.ok(runtime.getTask(message.taskId));
      taskId = message.taskId;
      process.send?.({ reply: message.id, value: sample() });
    } else if (message?.action === "release") {
      assert.ok(gates.has(message.gate), "SDK response gate must already be active");
      gates.get(message.gate)();
      process.send?.({ reply: message.id, value: sample() });
    } else if (message?.action === "sample") process.send?.({ reply: message.id, value: sample() });
  } catch (error) { process.send?.({ reply: message.id, error: String(error) }); }
});
process.on("disconnect", () => { unsubscribe(); originalSession?.dispose(); process.exit(); });
await import("./entry.mjs");
