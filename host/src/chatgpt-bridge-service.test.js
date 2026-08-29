import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAdvisoryMessage, createChatGptBridgeService, ChatGptBridgeError } from "./chatgpt-bridge-service.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "leafcode-c2c-host-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const artifact = join(root, "integrations", "codex-with-chatgpt");
  mkdirSync(join(artifact, "bin"), { recursive: true });
  mkdirSync(join(artifact, "dist", "cli"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(artifact, "package.json"), "{}\n", "utf8");
  writeFileSync(join(artifact, "bin", "c2c.js"), "", "utf8");
  writeFileSync(join(artifact, "dist", "cli", "index.js"), "", "utf8");
  writeFileSync(join(artifact, "package-lock.json"), "{}\n", "utf8");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "store.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "project-1", name: "Demo", rootPath: workspace }],
      tasks: [],
    }),
    "utf8",
  );
  return { root, dataDir, workspace };
}

test("ChatGPT Bridge is opt-in and resolves only registered projects", async () => {
  const values = fixture();
  const env = { LEAFCODE_PI_C2C_DISABLED: "0" };
  const service = createChatGptBridgeService({
    repoRoot: values.root,
    dataDir: values.dataDir,
    env,
    commandExists: () => false,
  });
  try {
    assert.equal((await service.status("project-1")).state, "disabled");
    assert.deepEqual(await service.setEnabled(true), { ok: true, enabled: true });

    const status = await service.status("project-1");
    assert.equal(status.state, "ready");
    const record = await service.record("project-1", {
      publicTaskId: "task-1",
      iteration: 1,
      tests: "27 passed",
      exitStatus: "ok",
    });
    assert.deepEqual(record, {
      ok: true,
      projectId: "project-1",
      publicTaskId: "task-1",
      iteration: 1,
      changedFiles: 0,
      tests: "27 passed",
      exitStatus: "ok",
    });
    const executed = await service.message("project-1", {
      kind: "executed",
      publicTaskId: "task-1",
      iteration: 1,
    });
    assert.match(executed.message, /TESTS: 27 passed/);
    assert.equal(executed.message.includes(values.workspace), false);

    assert.equal(status.projectId, "project-1");
    assert.equal(status.projectName, "Demo");
    assert.equal("workspaceRoot" in status, false);
    assert.equal(status.cloudflaredAvailable, false);

    assert.deepEqual(await service.session("project-1", { conversationUrl: "https://chatgpt.com/c/demo" }), {
      ok: true,
      projectId: "project-1",
      conversationUrl: "https://chatgpt.com/c/demo",
    });
    assert.equal((await service.status("project-1")).conversationUrl, "https://chatgpt.com/c/demo");
    await assert.rejects(
      () => service.session("project-1", { conversationUrl: "https://evil.example/c/demo" }),
      (error) => error instanceof ChatGptBridgeError && error.code === "INVALID_SESSION" && error.status === 400,
    );
    assert.deepEqual(await service.session("project-1", { conversationUrl: null }), {
      ok: true,
      projectId: "project-1",
      conversationUrl: null,
    });

    await assert.rejects(
      () => service.status("not-registered"),
      (error) => error instanceof ChatGptBridgeError && error.code === "PROJECT_NOT_FOUND" && error.status === 404,
    );
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});

test("advisory messages are bounded and omit absolute paths", () => {
  const message = buildAdvisoryMessage({
    kind: "init",
    publicTaskId: "task-1",
    iteration: 0,
    goal: "C:\\Users\\Daichi\\private\\repo /home/daichi/private/repo を確認してください",
  });
  assert.ok(Buffer.byteLength(message, "utf8") <= 1_024);
  assert.equal(message.includes("C:\\Users"), false);
  assert.equal(message.includes("/home/daichi"), false);
});

test("environment kill switch prevents Bridge activation", async () => {
  const values = fixture();
  const env = { LEAFCODE_PI_C2C_DISABLED: "1" };
  const service = createChatGptBridgeService({
    repoRoot: values.root,
    dataDir: values.dataDir,
    env,
    commandExists: () => true,
  });
  try {
    assert.deepEqual(await service.status("project-1"), {
      ok: true,
      enabled: false,
      artifactReady: true,
      cloudflaredAvailable: true,
      state: "disabled",
      projectId: null,
    });
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
});
