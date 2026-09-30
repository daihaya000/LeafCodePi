import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION } from "../../shared/backend-protocol.mjs";
import { REQUIRED_RUNTIME_EXPORTS } from "./runtime-loader.mjs";
import { BACKEND_UNAVAILABLE_STARTUP_STEPS } from "./startup.mjs";
import { readPendingRequestSnapshots } from "./pending-requests.mjs";

const permission = { id: "p1", taskId: "task-1", title: "Permission" };
const question = { id: "q1", taskId: "task-1", title: "Question" };

test("a detached runtime has no pending requests", () => {
  assert.deepEqual(readPendingRequestSnapshots(null), []);
});

test("delegated requests include unique Bot/Room origin keys through owner getters", () => {
  const reads = [];
  const runtime = {
    listPendingAttention: () => [
      { taskId: "code-1", originTaskId: "bot:room:r1" },
      { taskId: "code-2", originTaskId: "bot:room:r1" },
    ],
    pendingPermissionForTask: (id) => {
      reads.push(id);
      return id === "code-2" ? null : permission;
    },
    pendingQuestionForTask: (id) => id === "code-1" ? null : question,
  };
  assert.deepEqual(readPendingRequestSnapshots(runtime), [
    { taskId: "code-1", payload: { permissionRequest: permission, questionRequest: null } },
    { taskId: "bot:room:r1", payload: { permissionRequest: permission, questionRequest: question } },
    { taskId: "code-2", payload: { permissionRequest: null, questionRequest: question } },
  ]);
  assert.deepEqual(reads, ["code-1", "bot:room:r1", "code-2"]);
});

test("each read observes cleared requests even if an attention item was retained", () => {
  let current = permission;
  const runtime = {
    listPendingAttention: () => [{ taskId: "task-1" }],
    pendingPermissionForTask: () => current,
    pendingQuestionForTask: () => null,
  };
  assert.equal(readPendingRequestSnapshots(runtime).length, 1);
  current = null;
  assert.deepEqual(readPendingRequestSnapshots(runtime), []);
});

test("owner read failures reach the HTTP server's redaction boundary", () => {
  assert.throws(() => readPendingRequestSnapshots({ listPendingAttention() { throw new Error("read failed"); } }), /read failed/);
});

test("CLI exposes live pending DTOs and removes them after owner responses", { timeout: 10_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "leafcode-pending-cli-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const bundle = join(dataDir, "fake-runtime.mjs");
  const bodies = {
    listPendingAttention: 'return permission || question ? [{ taskId: "task-1" }] : [];',
    pendingPermissionForTask: 'return args[0] === "task-1" ? permission : null;',
    pendingQuestionForTask: 'return args[0] === "task-1" ? question : null;',
    respondToPermissionPrompt: 'if (args[0] !== "task-1" || args[1] !== permission?.id) return false; permission = null; return true;',
    respondToQuestionPrompt: 'if (args[0] !== "task-1" || args[1] !== question?.id) return false; question = null; return true;',
  };
  // No SDK import, prompts or real user store: only the entry's runtime/HTTP wiring is exercised.
  writeFileSync(bundle, [
    `let permission = ${JSON.stringify(permission)};`,
    `let question = ${JSON.stringify(question)};`,
    ...REQUIRED_RUNTIME_EXPORTS.map((name) => `export function ${name}(...args) { ${bodies[name] ?? "return null;"} }`),
  ].join("\n"), "utf8");
  const token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./entry.mjs", import.meta.url))], {
    env: {
      ...process.env, NODE_ENV: "test", LEAFCODE_PI_DATA_DIR: dataDir,
      LEAFCODE_PI_BACKEND_TOKEN: token, LEAFCODE_PI_BACKEND_PORT: "0",
      LEAFCODE_PI_BACKEND_RUNTIME: "attach", LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE: bundle,
      LEAFCODE_PI_BACKEND_GENERATION: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  });
  const [line] = await once(lines, "line");
  const { port } = JSON.parse(line);
  const base = `http://127.0.0.1:${port}/internal`;
  const headers = { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION) };
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(2_000),
  });
  const snapshots = async () => {
    const response = await request("/pending-snapshots");
    assert.equal(response.status, 200);
    return response.json();
  };
  // The fake runtime is attached once the pending read sees it. Health stays 503 regardless: this
  // build still lacks required startup steps, so it must not present itself as a replacement.
  const deadline = Date.now() + 5_000;
  let first = null;
  while (Date.now() < deadline) {
    first = await snapshots();
    if (first.snapshots.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(first, {
    snapshots: [{ taskId: "task-1", payload: { permissionRequest: permission, questionRequest: question } }],
  });
  const health = await request("/health");
  assert.equal(health.status, 503);
  const healthBody = await health.json();
  assert.ok(healthBody.runtimeGeneration, "the fake runtime never attached");
  assert.deepEqual(healthBody.runtimeStartupIncomplete, [...BACKEND_UNAVAILABLE_STARTUP_STEPS]);
  const respond = (kind, body) => request(`/tasks/task-1/${kind}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await respond("permission", { requestId: "p1", approved: true })).status, 200);
  assert.deepEqual(await snapshots(), {
    snapshots: [{ taskId: "task-1", payload: { permissionRequest: null, questionRequest: question } }],
  });
  assert.equal((await respond("question", { requestId: "q1", answer: null })).status, 200);
  assert.deepEqual(await snapshots(), { snapshots: [] });
});
