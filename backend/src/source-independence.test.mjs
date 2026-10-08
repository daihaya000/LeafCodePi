import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Real build and process startup from a fixture that has no web directory at all. */
test("Backend builds and serves its runtime API without Web sources or Web packages", { timeout: 30_000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "leafcode-backend-independent-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill();
      await exited;
    }
    rmSync(fixture, { recursive: true, force: true });
  });
  const backend = join(fixture, "backend");
  mkdirSync(backend);
  for (const path of ["src", "core", "runtime-src", "types", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.runtime.json"]) {
    cpSync(join(ROOT, "backend", path), join(backend, path), { recursive: true });
  }
  // Only Backend-installed dependencies are available; no Web node_modules or root dependencies.
  symlinkSync(join(ROOT, "backend", "node_modules"), join(backend, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  cpSync(join(ROOT, "shared"), join(fixture, "shared"), { recursive: true });
  mkdirSync(join(fixture, "scripts"));
  cpSync(join(ROOT, "scripts", "build-backend-runtime.mjs"), join(fixture, "scripts", "build-backend-runtime.mjs"));
  for (const path of ["leafcode-subagents/src/api/background-work.ts", "leafcode-todowrite/visibility.ts"]) {
    const target = join(fixture, "extensions", path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, "extensions", path), target);
  }
  assert.equal(existsSync(join(fixture, "web")), false);
  const built = spawnSync(process.execPath, [join(fixture, "scripts", "build-backend-runtime.mjs"), "--force"], {
    cwd: fixture, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(built.status, 0, built.stderr || built.error?.message);
  assert.ok(existsSync(join(backend, "runtime", "runtime.bundle.mjs")));

  const data = join(fixture, "data"), agent = join(fixture, "agent");
  mkdirSync(data); mkdirSync(agent);
  writeFileSync(join(data, "store.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture-project", name: "Fixture", rootPath: join(fixture, "workspaces"), archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], tasks: [{
    id: "independent-task", projectId: null, projectName: "test", title: "Backend-owned task", directory: fixture,
    isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }] }));
  const token = randomBytes(32).toString("hex");
  const launchOptions = {
    cwd: fixture, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: agent,
      LEAFCODE_PI_DATA_DIR: data, LEAFCODE_PI_DEFAULT_DIR: join(fixture, "workspaces"), APPDATA: join(fixture, "roaming"),
      LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_RUNTIME: "1",
      LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_MCP_NATIVE: "", LEAFCODE_PI_PROCESS_ROLE: "backend",
      LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: join(backend, "runtime", "runtime.bundle.mjs"),
      LEAFCODE_PI_PUSHOVER_TOKEN: "", LEAFCODE_PI_PUSHOVER_USER: "", LEAFCODE_PI_WEBUI_AUTH: "required" },
  };
  const launch = () => spawn(process.execPath, [join(backend, "src", "entry.mjs")], launchOptions);
  child = launch();
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 12_000;
  let listening;
  while (!listening && Date.now() < deadline && child.exitCode === null) {
    for (const line of stdout.split(/\r?\n/)) {
      try { const record = JSON.parse(line); if (record.type === "backend_listening") listening = record; } catch { /* incomplete output */ }
    }
    if (!listening) await delay(25);
  }
  assert.ok(listening, stderr || "Backend did not listen");
  const base = `http://127.0.0.1:${listening.port}`;
  const headers = { authorization: `Bearer ${token}`, "x-leafcode-backend-protocol": "1" };
  let health;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/internal/health`, { headers, signal: AbortSignal.timeout(3_000) });
      health = await response.json();
      if (response.status === 200 && health.ready) break;
    } catch (error) {
      if (error.name !== "TimeoutError" && error.name !== "AbortError") throw error;
    }
    await delay(50);
  }
  assert.equal(health?.ready, true, `${stderr} readiness=${JSON.stringify(health)}`);
  const response = await fetch(`${base}/internal/tasks`, { headers, signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.tasks.find((task) => task.id === "independent-task")?.title, "Backend-owned task");
  assert.equal((await fetch(`${base}/internal/tasks`, { signal: AbortSignal.timeout(2_000) })).status, 401);

  const configHeaders = { ...headers, "content-type": "application/json", "x-leafcode-configuration-origin": "http://localhost",
    "x-leafcode-configuration-host": "localhost", "x-leafcode-configuration-authorized": "1",
    "x-leafcode-configuration-operation": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  const saved = await fetch(`${base}/internal/configuration/settings/history-page-size`, {
    method: "PUT", headers: configHeaders, body: JSON.stringify({ value: "100" }), signal: AbortSignal.timeout(3_000),
  });
  const committed = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(committed));
  assert.equal(committed.mutation.saved, true); assert.equal(committed.mutation.saveStatus, "complete");
  assert.ok(committed.mutation.revision);
  const savedPath = join(data, "web-settings.json");
  assert.equal(JSON.parse(readFileSync(savedPath, "utf8"))["history-page-size"], "100");

  // Real Git business owner: fixture-only commands/files, no Next sources or fallback.
  const workspace = join(fixture, "workspaces"); mkdirSync(workspace);
  const businessHeaders = { ...headers, "content-type": "application/json", "x-leafcode-business-origin": "http://localhost",
    "x-leafcode-business-host": "localhost", "x-leafcode-business-authorized": "1" };
  const business = async (route, body, query = "", extraHeaders = {}, method = "POST") => {
    const reply = await fetch(`${base}/internal/json-business/${route}${query}`, { headers: { ...businessHeaders, ...extraHeaders },
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    assert.equal(reply.status, 200); return reply.json();
  };
  assert.equal((await business("git/init", { directory: workspace })).body.ok, true);
  writeFileSync(join(workspace, "README.md"), "Owner-only fixture\n");
  const committedGit = await business("git/commit", { directory: workspace, paths: ["README.md"], message: "独立API検証" });
  assert.equal(committedGit.status, 200, JSON.stringify(committedGit)); assert.equal(committedGit.body.ok, true);
  const query = `?directory=${encodeURIComponent(workspace)}`;
  const history = await business("git/log", undefined, query);
  assert.equal(history.body.commits.length, 1); assert.match(history.body.commits[0].subject, /独立API検証/);
  const conditional = await business("git/log", undefined, query, { "if-none-match": history.headers.etag });
  assert.equal(conditional.status, 304); assert.equal(conditional.body, null);
  const branches = await business("git/branches", undefined, query); assert.equal(branches.status, 200);
  const shown = await business("git/show", undefined, `${query}&commit=${history.body.commits[0].hash}`);
  assert.equal(shown.body.files[0].path, "README.md");
  writeFileSync(join(workspace, "README.md"), "Owner-only fixture\nchanged\n");
  const diff = await business("diff/files", undefined, query);
  assert.equal(diff.body.git, true); assert.ok(diff.body.files.some(file => file.path === "README.md"));
  const suggestion = await business("git/commit-message", { directory: workspace, files: [{ path: "README.md", additions: 1, deletions: 0 }] });
  assert.equal(suggestion.body.source, "fallback"); assert.ok(suggestion.body.message);
  const unsafe = await business("git/merge", { directory: workspace, branch: "--help" }); assert.equal(unsafe.status, 400);
  const outside = await business("git/branches", undefined, "?directory=" + encodeURIComponent(process.platform === "win32" ? "C:\\Windows" : "/etc"));
  assert.equal(outside.status, 403);
  // Workspace file selection and suggestion validation run entirely in this owner.
  const workspaceListing = await business("projects/fixture-project/files", undefined); assert.equal(workspaceListing.status, 200); assert.ok(workspaceListing.body.entries.some(entry => entry.name === "README.md"));
  const workspaceFile = await business("projects/fixture-project/files", undefined, "?path=README.md&read=1"); assert.equal(workspaceFile.status, 200); assert.equal(Buffer.from(workspaceFile.body.data, "base64").toString("utf8"), "Owner-only fixture\nchanged\n");
  const taskFile = await business("tasks/independent-task/files", undefined, "?path=workspaces%2FREADME.md&read=1"); assert.equal(taskFile.status, 200); assert.equal(taskFile.body.data, workspaceFile.body.data);
  const workspaceEscape = await business("projects/fixture-project/files", undefined, "?path=..%2Fdata%2Fstore.json&read=1"); assert.equal(workspaceEscape.status, 400);
  const workspaceId = await business("projects/fixture%252Fproject/files", undefined); assert.equal(workspaceId.status, 400);
  writeFileSync(join(workspace, "invalid.txt"), Buffer.from([0xff, 0xfe])); assert.equal((await business("projects/fixture-project/files", undefined, "?path=invalid.txt&read=1")).status, 415);
  const refusedSuggestion = await business("projects/fixture-project/next-task", {}); assert.equal(refusedSuggestion.status, 400); assert.equal(refusedSuggestion.body.mutation, undefined); assert.equal(refusedSuggestion.body.operation, undefined);
  // Definition writes/reload/receipts happen in this same Web-free owner.
  const definitionOperation = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const definitionReply = await business("agents-md", { content: "Isolated owner 日本語" }, "", { "x-leafcode-business-operation": definitionOperation }, "PATCH");
  assert.equal(definitionReply.status, 200, JSON.stringify(definitionReply));
  assert.equal(definitionReply.body.mutation.saved, true); assert.equal(definitionReply.body.mutation.apply, "applied");
  assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), "Isolated owner 日本語");
  const createdAgent = await business("agents", { name: "isolated", systemPrompt: "Fixture persona" }, "", { "x-leafcode-business-operation": "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa" });
  assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent)); assert.equal(createdAgent.body.mutation.saved, true);
  const agentDraft = await business("agents/isolated", undefined); assert.equal(agentDraft.body.draft.systemPrompt, "Fixture persona");
  const illegalAgent = await business("agents/%2E%2E%2Fescape", { enabled: true }, "", { "x-leafcode-business-operation": "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb" }, "PATCH");
  assert.equal(illegalAgent.status, 400);
  assert.equal(existsSync(join(fixture, "escape.md")), false);
  const authOperation = "11111111-2222-3333-4444-555555555555";
  const refusedLogin = await business("providers/fixture/login", { type: "invalid" }, "", { "x-leafcode-business-operation": authOperation });
  assert.equal(refusedLogin.status, 400); assert.equal(refusedLogin.body.operation.execution, "complete");
  const loginEvents = await fetch(`${base}/internal/provider-login-events/fixture?sessionId=missing`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal(loginEvents.status, 200); assert.match(await loginEvents.text(), /event: done[\s\S]*"ok":false/);
  const endpointOperation = "eeeeeeee-ffff-aaaa-bbbb-cccccccccccc";
  const endpointReply = await business("providers/leafcodecloud/base-url", { baseUrl: "http://127.0.0.1:1/v1" }, "", { "x-leafcode-business-operation": endpointOperation }, "PUT");
  assert.equal(endpointReply.status, 200, JSON.stringify(endpointReply));
  assert.equal(endpointReply.body.mutation.saved, true); assert.equal(endpointReply.body.mutation.apply, "deferred");
  assert.equal((await business("providers/leafcodecloud/base-url")).body.baseUrl, "http://127.0.0.1:1/v1");
  const modelReply = await business("provider-models/fixture%3A%3Amodel", { contextWindow: 16384 }, "", { "x-leafcode-business-operation": "ffffffff-aaaa-bbbb-cccc-dddddddddddd" }, "PATCH");
  assert.equal(modelReply.status, 200, JSON.stringify(modelReply)); assert.equal(modelReply.body.mutation.saved, true);
  assert.equal(JSON.parse(readFileSync(join(data, "provider-model-state.json"), "utf8")).contextWindow["fixture::model"], 16384);
  // Account records and credentials are persisted by this same owner, not a Next or global-user fallback.
  const accountOperation = "22222222-3333-4444-5555-666666666666";
  const accountReply = await business("accounts", { label: "Isolated account", providers: ["openrouter"] }, "", { "x-leafcode-business-operation": accountOperation });
  assert.equal(accountReply.status, 200, JSON.stringify(accountReply)); assert.equal(accountReply.body.mutation.saved, true);
  const accountId = accountReply.body.account.id;
  const creditOperation = "33333333-4444-5555-6666-777777777777";
  const creditReply = await business(`accounts/${accountId}/openrouter-credits`, { managementKey: "PRIVATE-FIXTURE-KEY" }, "", { "x-leafcode-business-operation": creditOperation });
  assert.equal(creditReply.status, 200); assert.equal(creditReply.body.mutation.saved, true);
  assert.ok(!JSON.stringify(creditReply).includes("PRIVATE"));
  const creditPath = join(agent, "accounts", accountId, "openrouter.json");
  assert.equal(JSON.parse(readFileSync(creditPath, "utf8")).managementKey, "PRIVATE-FIXTURE-KEY");
  const accountStatus = await business(`accounts/${accountId}/auth-status`);
  assert.equal(accountStatus.body.openrouterManagementKeyConfigured, true); assert.ok(!JSON.stringify(accountStatus).includes("PRIVATE"));
  assert.ok(!readFileSync(join(data, "configuration-command.json"), "utf8").includes("PRIVATE"));
  const illegalAccount = await fetch(`${base}/internal/json-business/accounts/%2E%2E%2Fescape/openrouter-credits`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": "44444444-5555-6666-7777-888888888888" }, body: JSON.stringify({ managementKey: "PRIVATE-REFUSED" }), signal: AbortSignal.timeout(3000) });
  assert.equal(illegalAccount.status, 404); assert.equal(existsSync(join(agent, "escape")), false);
  // Native usage feature: real catalog save/read and admission rejection; never redeem a real external credit.
  const usageCatalog = await business("codexbar/providers", undefined);
  assert.equal(usageCatalog.status, 200); assert.ok(Array.isArray(usageCatalog.body.providers));
  const usageConfigOperation = "55555555-6666-7777-8888-999999999999";
  const usageConfig = await business("codexbar/providers", { providerId: "cursor", enabled: false, version: usageCatalog.body.version }, "", { "x-leafcode-business-operation": usageConfigOperation }, "PUT");
  assert.equal(usageConfig.status, 200, JSON.stringify(usageConfig)); assert.equal(usageConfig.body.mutation.saved, true);
  assert.equal(JSON.parse(readFileSync(join(fixture, "roaming", "CodexBar", "config.json"), "utf8")).enabledProviders.includes("cursor"), false);
  assert.equal((await business("codexbar/usage", undefined, "?scope=invalid")).status, 400);
  assert.equal((await business("codexbar/reset-credits", undefined, "?accountId=missing")).status, 404);
  const usageOperation = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const rejectedConsume = await business("codexbar/reset-credits", { creditId: "" }, "", { "x-leafcode-business-operation": usageOperation });
  assert.equal(rejectedConsume.status, 400); assert.equal(rejectedConsume.body.operation.execution, "complete"); assert.equal(rejectedConsume.body.mutation, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(data, "usage-command.json"), "utf8")).operations, [{ id: usageOperation, execution: "complete" }]);
  // Real Peer owner: create/revoke tokens and lease only this fixture's named-account API key.
  writeFileSync(join(agent, "accounts", accountId, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "PEER-FIXTURE-LEASE", refresh: "PRIVATE-NEVER-EXPORT" } }));
  const peerOperation = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const peerGrantReply = await business("peer-auth/peers", { label: "Fixture peer", providers: ["openrouter"] }, "", { "x-leafcode-business-operation": peerOperation });
  assert.equal(peerGrantReply.status, 201); assert.equal(peerGrantReply.body.mutation.saved, true);
  const peerToken = peerGrantReply.body.token; assert.ok(peerToken); assert.ok(!readFileSync(join(data, "peer-auth.json"), "utf8").includes(peerToken));
  const peerEnabled = await business("peer-auth/peers", { enabled: true }, "", { "x-leafcode-business-operation": "88888888-9999-aaaa-bbbb-cccccccccccc" }, "PATCH"); assert.equal(peerEnabled.status, 200);
  const peerHeaders = { ...businessHeaders, "x-leafcode-business-authorized": "0", "x-leafcode-business-peer-authorization": `Bearer ${peerToken}` };
  const peerRequest = async (origin, route, body) => { const response = await fetch(`${origin}/internal/json-business/${route}`, { headers: peerHeaders, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200); return response.json(); };
  const peerList = await peerRequest(base, "peer-auth/list"); assert.equal(peerList.status, 200); assert.equal(peerList.body.accounts[0].accountId, accountId); assert.ok(!JSON.stringify(peerList).includes("PEER-FIXTURE-LEASE"));
  const peerLease = await peerRequest(base, "peer-auth/resolve", { providerId: "openrouter", accountId }); assert.equal(peerLease.status, 200); assert.deepEqual(peerLease.body, { credential: { type: "api_key", key: "PEER-FIXTURE-LEASE" } });
  assert.equal((await peerRequest(base, "peer-auth/resolve", { providerId: "openrouter" })).status, 403);
  const unauthImport = await fetch(`${base}/internal/json-business/peer-auth/import`, { headers: peerHeaders, signal: AbortSignal.timeout(3000) }); assert.equal(unauthImport.status, 403);
  // Full Project lifecycle in this Web-free owner; move only this isolated workspace.
  const lifecycleSource = join(fixture, "lifecycle-source"), lifecycleDestination = join(fixture, "lifecycle-destination"); mkdirSync(lifecycleSource); writeFileSync(join(lifecycleSource, "keep.txt"), "Project owner fixture\n");
  const projectOperation = "abababab-bbbb-cccc-dddd-eeeeeeeeeeee";
  const projectCreated = await business("projects", { rootPath: lifecycleSource }, "", { "x-leafcode-business-operation": projectOperation }); assert.equal(projectCreated.status, 200); assert.equal(projectCreated.body.operation.execution, "complete"); const lifecycleId = projectCreated.body.project.id;
  const projectIcon = await business("projects", { id: lifecycleId, icon: "data:image/png;base64,YQ==" }, "", { "x-leafcode-business-operation": "bcbcbcbc-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectIcon.status, 200);
  const projectMoved = await business("projects", { id: lifecycleId, destinationPath: lifecycleDestination }, "", { "x-leafcode-business-operation": "cdcdcdcd-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectMoved.status, 200); assert.equal(readFileSync(join(lifecycleDestination, "keep.txt"), "utf8"), "Project owner fixture\n"); assert.equal(existsSync(lifecycleSource), false);
  const projectArchived = await business("projects", { id: lifecycleId, archived: true }, "", { "x-leafcode-business-operation": "dededede-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectArchived.body.project.archived, true);
  const projectRestored = await business("projects", { id: lifecycleId, archived: false }, "", { "x-leafcode-business-operation": "efefefef-bbbb-cccc-dddd-eeeeeeeeeeee" }, "PATCH"); assert.equal(projectRestored.body.project.archived, false);
  const projectList = await business("projects", undefined, "?archived=1"); assert.match(projectList.body.projects.find(project => project.id === lifecycleId).icon, /\/api\/projects\/.+\/icon\?v=/); assert.ok(!readFileSync(join(data, "project-command.json"), "utf8").includes(lifecycleSource));
  // Restart the actual owner process, retaining only its disk state, not a Web fallback or a module cache.
  const exited = new Promise((done) => child.once("exit", done)); child.kill(); await exited;
  stdout = ""; stderr = ""; listening = undefined; child = launch();
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const restartDeadline = Date.now() + 8_000;
  while (!listening && Date.now() < restartDeadline && child.exitCode === null) {
    for (const line of stdout.split(/\\r?\\n/)) {
      try { const record = JSON.parse(line); if (record.type === "backend_listening") listening = record; } catch { /* partial line */ }
    }
    if (!listening) await delay(25);
  }
  assert.ok(listening, stderr);
  const restartedBase = `http://127.0.0.1:${listening.port}`;
  let restored;
  while (Date.now() < restartDeadline) {
    const reply = await fetch(`${restartedBase}/internal/configuration/settings/history-page-size`, { headers: configHeaders, signal: AbortSignal.timeout(3_000) });
    if (reply.status === 200) { restored = await reply.json(); break; }
    await delay(50);
  }
  assert.equal(restored?.value, "100", stderr);
  const outcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${committed.mutation.operationId}`, { headers: configHeaders, signal: AbortSignal.timeout(3_000) });
  assert.equal(outcome.status, 200); assert.deepEqual((await outcome.json()).mutation, committed.mutation);
  const gitAfterRestart = await fetch(`${restartedBase}/internal/json-business/git/log${query}`, { headers: businessHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal(gitAfterRestart.status, 200);
  assert.equal((await gitAfterRestart.json()).body.commits[0].hash, history.body.commits[0].hash);
  const definitionRestored = await fetch(`${restartedBase}/internal/json-business/agents-md`, { headers: businessHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal((await definitionRestored.json()).body.content, "Isolated owner 日本語");
  const definitionOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${definitionOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await definitionOutcome.json()).mutation, definitionReply.body.mutation);
  const definitionReplay = await fetch(`${restartedBase}/internal/json-business/agents-md`, { method: "PATCH", headers: { ...businessHeaders, "x-leafcode-business-operation": definitionOperation },
    body: JSON.stringify({ content: "No replay" }), signal: AbortSignal.timeout(5000) });
  assert.equal((await definitionReplay.json()).status, 409);
  assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), "Isolated owner 日本語");
  const endpointRestored = await fetch(`${restartedBase}/internal/json-business/providers/leafcodecloud/base-url`, { headers: businessHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal((await endpointRestored.json()).body.baseUrl, "http://127.0.0.1:1/v1");
  const endpointOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${endpointOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await endpointOutcome.json()).mutation, endpointReply.body.mutation);
  assert.equal(JSON.parse(readFileSync(join(data, "provider-model-state.json"), "utf8")).contextWindow["fixture::model"], 16384);
  const authReplay = await fetch(`${restartedBase}/internal/json-business/providers/fixture/login`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": authOperation }, body: JSON.stringify({ type: "invalid" }), signal: AbortSignal.timeout(3000) });
  assert.equal((await authReplay.json()).status, 409);
  const accountsRestored = await fetch(`${restartedBase}/internal/json-business/accounts`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal((await accountsRestored.json()).body.accounts[0].id, accountId);
  const accountStatusRestored = await fetch(`${restartedBase}/internal/json-business/accounts/${accountId}/auth-status`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  const restoredStatus = await accountStatusRestored.json(); assert.equal(restoredStatus.body.openrouterManagementKeyConfigured, true); assert.ok(!JSON.stringify(restoredStatus).includes("PRIVATE"));
  const creditOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${creditOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await creditOutcome.json()).mutation, creditReply.body.mutation);
  const accountReplay = await fetch(`${restartedBase}/internal/json-business/accounts`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": accountOperation }, body: JSON.stringify({ label: "No replay", providers: ["openrouter"] }), signal: AbortSignal.timeout(3000) });
  assert.equal((await accountReplay.json()).status, 409);
  const creditReplay = await fetch(`${restartedBase}/internal/json-business/accounts/${accountId}/openrouter-credits`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": creditOperation }, body: JSON.stringify({ managementKey: "PRIVATE-NO-REPLAY" }), signal: AbortSignal.timeout(3000) });
  assert.equal((await creditReplay.json()).status, 409); assert.equal(JSON.parse(readFileSync(creditPath, "utf8")).managementKey, "PRIVATE-FIXTURE-KEY");
  const usageCatalogRestored = await fetch(`${restartedBase}/internal/json-business/codexbar/providers`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) });
  assert.equal((await usageCatalogRestored.json()).body.version, usageConfig.body.version);
  const usageConfigOutcome = await fetch(`${restartedBase}/internal/configuration/settings?operationId=${usageConfigOperation}`, { headers: configHeaders, signal: AbortSignal.timeout(3000) });
  assert.deepEqual((await usageConfigOutcome.json()).mutation, usageConfig.body.mutation);
  const consumeReplay = await fetch(`${restartedBase}/internal/json-business/codexbar/reset-credits`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": usageOperation }, body: JSON.stringify({ creditId: "must-not-execute" }), signal: AbortSignal.timeout(3000) });
  assert.equal((await consumeReplay.json()).status, 409);
  const projectReplay = await fetch(`${restartedBase}/internal/json-business/projects`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": projectOperation }, body: JSON.stringify({ rootPath: lifecycleDestination }), signal: AbortSignal.timeout(3000) }); assert.equal((await projectReplay.json()).status, 409);
  const lifecycleList = await fetch(`${restartedBase}/internal/json-business/projects?archived=1`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); const lifecycleMetadata = (await lifecycleList.json()).body.projects.find(project => project.id === lifecycleId); assert.equal(lifecycleMetadata.rootPath, lifecycleDestination); assert.equal(lifecycleMetadata.archived, false);
  const lifecycleDelete = await fetch(`${restartedBase}/internal/json-business/projects?id=${lifecycleId}`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": "fafafafa-bbbb-cccc-dddd-eeeeeeeeeeee" }, signal: AbortSignal.timeout(3000) }); assert.equal((await lifecycleDelete.json()).status, 200); assert.equal(existsSync(join(lifecycleDestination, "keep.txt")), true);
  const restartedFile = await fetch(`${restartedBase}/internal/json-business/projects/fixture-project/files?path=README.md&read=1`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); const restoredFile = await restartedFile.json(); assert.equal(restoredFile.status, 200); assert.deepEqual(restoredFile.body, workspaceFile.body);
  const peerLeaseRestored = await peerRequest(restartedBase, "peer-auth/resolve", { providerId: "openrouter", accountId }); assert.deepEqual(peerLeaseRestored.body, peerLease.body);
  const peerGrantReplay = await fetch(`${restartedBase}/internal/json-business/peer-auth/peers`, { method: "POST", headers: { ...businessHeaders, "x-leafcode-business-operation": peerOperation }, body: JSON.stringify({ label: "No replay", providers: ["openrouter"] }), signal: AbortSignal.timeout(3000) }); assert.equal((await peerGrantReplay.json()).status, 409);
  const peerMetadata = await fetch(`${restartedBase}/internal/json-business/peer-auth/peers`, { headers: businessHeaders, signal: AbortSignal.timeout(3000) }); assert.ok(!JSON.stringify(await peerMetadata.json()).includes(peerToken));
  const peerRevoke = await fetch(`${restartedBase}/internal/json-business/peer-auth/peers?id=${peerGrantReply.body.grant.id}`, { method: "DELETE", headers: { ...businessHeaders, "x-leafcode-business-operation": "99999999-aaaa-bbbb-cccc-dddddddddddd" }, signal: AbortSignal.timeout(3000) }); assert.equal((await peerRevoke.json()).status, 200);
  assert.equal((await peerRequest(restartedBase, "peer-auth/list")).status, 401);
  assert.equal(existsSync(join(fixture, "web")), false);
});
