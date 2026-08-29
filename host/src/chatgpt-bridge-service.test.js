import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChatGptBridgeService, ChatGptBridgeError } from "./chatgpt-bridge-service.js";

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
    assert.equal(status.projectId, "project-1");
    assert.equal(status.projectName, "Demo");
    assert.equal("workspaceRoot" in status, false);
    assert.equal(status.cloudflaredAvailable, false);

    await assert.rejects(
      () => service.status("not-registered"),
      (error) => error instanceof ChatGptBridgeError && error.code === "PROJECT_NOT_FOUND" && error.status === 404,
    );
  } finally {
    rmSync(values.root, { recursive: true, force: true });
  }
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
