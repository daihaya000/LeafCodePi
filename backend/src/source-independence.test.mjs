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
test("Backend builds and serves its runtime API without Web sources or Web packages", { timeout: 25_000 }, async (t) => {
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
  writeFileSync(join(data, "store.json"), JSON.stringify({ version: 1, projects: [], tasks: [{
    id: "independent-task", projectId: null, projectName: "test", title: "Backend-owned task", directory: fixture,
    isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }] }));
  const token = randomBytes(32).toString("hex");
  const launchOptions = {
    cwd: fixture, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", PI_CODING_AGENT_DIR: agent,
      LEAFCODE_PI_DATA_DIR: data, LEAFCODE_PI_DEFAULT_DIR: join(fixture, "workspaces"),
      LEAFCODE_PI_BACKEND_PORT: "0", LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_RUNTIME: "1",
      LEAFCODE_PI_BACKEND_GENERATION: "", LEAFCODE_PI_MCP_NATIVE: "",
      LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: join(backend, "runtime", "runtime.bundle.mjs"),
      LEAFCODE_PI_PUSHOVER_TOKEN: "", LEAFCODE_PI_PUSHOVER_USER: "" },
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
  assert.equal(existsSync(join(fixture, "web")), false);
});
