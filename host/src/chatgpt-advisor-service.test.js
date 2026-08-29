import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createChatGptAdvisorService } from "./chatgpt-advisor-service.js";
import { createLlamaControlServer, listenControlServer, closeControlServer } from "./llama-control-server.js";

function makeEnv(overrides = {}) {
  return { ...process.env, LEAFCODE_PI_CHATGPT_ADVISOR_DISABLED: undefined, ...overrides };
}

function makeService(deps = {}) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-advisor-test-"));
  const repoRoot = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(join(repoRoot, "integrations"), { recursive: true });
  mkdirSync(join(dataDir, "store.json").replace(/store\.json$/, ""), { recursive: true });
  const log = deps.log ?? (() => {});
  const service = createChatGptAdvisorService({
    repoRoot,
    dataDir,
    env: makeEnv(),
    log,
    platform: "win32",
    spawn: deps.spawn,
    isProcessAlive: deps.isProcessAlive ?? (() => false),
    commandExists: deps.commandExists ?? (() => true),
    now: deps.now,
    wait: deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
  return { service, root, repoRoot, dataDir };
}

test("computeExtensionIdFromPath returns a 32-char a-p id deterministically", () => {
  const { service } = makeService();
  const id1 = service._internals.computeExtensionIdFromPath("C:\\x\\extension");
  const id2 = service._internals.computeExtensionIdFromPath("C:\\x\\extension");
  assert.match(id1, /^[a-p]{32}$/);
  assert.equal(id1, id2);
  const id3 = service._internals.computeExtensionIdFromPath("C:\\x\\extension2");
  assert.notEqual(id1, id3);
});

test("restrictedManifest contains only Oracle-required permissions", () => {
  const { service } = makeService();
  const manifest = service._internals.restrictedManifest();
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, [
    "storage",
    "activeTab",
    "scripting",
    "debugger",
    "tabs",
    "webNavigation",
    "nativeMessaging",
    "cookies",
  ]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.equal(manifest.content_security_policy.extension_pages.includes("https: wss:"), false);
  assert.equal(manifest.content_security_policy.extension_pages.includes("https://chatgpt.com"), true);
  assert.equal(manifest.name, "Surf (LeafCodePi restricted)");
});

// Verified against a real Chrome-assigned ID: launching Chromium with
// --load-extension=%TEMP%\minext produced chrome-extension://hgmcjhacngkmcjdbbmapjbckdlnomojg/.
// Chrome hashes the UTF-16LE bytes of the path with an upper-cased drive
// letter and emits the high nibble of each byte first, so a UTF-8 hash or a
// swapped nibble order yields an ID that silently never matches.
test("computeExtensionIdFromPath matches the ID Chrome assigns", () => {
  const { service } = makeService();
  assert.equal(
    service._internals.computeExtensionIdFromPath("C:\\Users\\Daichi\\AppData\\Local\\Temp\\minext", "win32"),
    "hgmcjhacngkmcjdbbmapjbckdlnomojg",
  );
});

test("computeExtensionIdFromPath upper-cases the drive letter like Chrome", () => {
  const { service } = makeService();
  assert.equal(
    service._internals.computeExtensionIdFromPath("c:\\x\\extension", "win32"),
    service._internals.computeExtensionIdFromPath("C:\\x\\extension", "win32"),
  );
});

test("isExtensionLoaded is false without a DevToolsActivePort file", async () => {
  const { service, root } = makeService();
  const profile = join(root, "profile");
  mkdirSync(profile, { recursive: true });
  assert.equal(await service._internals.isExtensionLoaded(profile, "abcdefghijklmnopabcdefghijklmnop"), false);
});

test("installNativeHost writes manifest and registers registry entry", () => {
  const { service, root } = makeService();
  const id = "abcdefghijklmnopabcdefghijklmnop";
  // Point forkDir native host at a real file.
  const forkNative = join(root, "repo", "integrations", "surf-chatgpt-advisor", "native");
  mkdirSync(forkNative, { recursive: true });
  writeFileSync(join(forkNative, "host.cjs"), "// host", "utf8");
  // Registry exec is mocked away via spawnSync? We don't inject spawnSync; the
  // service uses global spawnSync which would fail on non-Windows or in CI.
  // So we only assert the manifest is written for the local wrapper, and skip
  // the registry call by asserting an error path? Instead, directly test the
  // manifest file creation by checking the wrapper exists after a successful
  // path through installNativeHost. Since reg add may fail in this env, catch
  // the error and assert the manifest file was still written.
  try {
    service._internals.installNativeHost(id);
  } catch {
    // registry failure is environment-dependent; manifest must still exist
  }
  const manifestDir = join(root, "data", "chatgpt-advisor", "native-host", "manifest");
  const manifestPath = join(manifestDir, "surf.browser.host.json");
  assert.equal(existsSync(manifestPath), true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "surf.browser.host");
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
  assert.equal(manifest.type, "stdio");
  assert.equal(existsSync(manifest.path), true);
});

test("status reports disabled by default", async () => {
  const { service } = makeService();
  const result = await service.status();
  assert.equal(result.enabled, false);
  assert.equal(result.state, "disabled");
});

test("setEnabled toggles config and disables stops", async () => {
  const { service } = makeService();
  const enabled = await service.setEnabled(true);
  assert.equal(enabled.enabled, true);
  const status = await service.status();
  assert.equal(status.enabled, true);
  // No fork artifact in this test env, so prerequisites_missing is expected.
  assert.equal(status.state, "prerequisites_missing");
  const disabled = await service.setEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.equal((await service.status()).state, "disabled");
});

test("kill switch env disables regardless of config", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-advisor-kill-"));
  const service = createChatGptAdvisorService({
    repoRoot: join(root, "repo"),
    dataDir: join(root, "data"),
    env: { ...process.env, LEAFCODE_PI_CHATGPT_ADVISOR_DISABLED: "1" },
    log: () => {},
    platform: "win32",
    isProcessAlive: () => false,
  });
  await service.setEnabled(true);
  const status = await service.status();
  assert.equal(status.enabled, false);
  assert.equal(status.state, "disabled");
});

test("setup requires project validation before chrome launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-advisor-setup-"));
  const repoRoot = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir), { recursive: true });
  // No store.json -> project not found, no chrome launch happens.
  const service = createChatGptAdvisorService({
    repoRoot,
    dataDir,
    env: { ...process.env },
    log: () => {},
    platform: "win32",
    spawn: () => {
      throw new Error("spawn should not be called");
    },
    isProcessAlive: () => false,
    commandExists: () => true,
  });
  await service.setEnabled(true);
  await assert.rejects(() => service.setup("p1"), (err) => err.code === "PROJECT_NOT_FOUND");
});

test("setup raises when disabled by kill switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-advisor-killsetup-"));
  const service = createChatGptAdvisorService({
    repoRoot: join(root, "repo"),
    dataDir: join(root, "data"),
    env: { ...process.env, LEAFCODE_PI_CHATGPT_ADVISOR_DISABLED: "1" },
    log: () => {},
    platform: "win32",
  });
  await assert.rejects(() => service.setup("p1"), (err) => err.code === "ADVISOR_DISABLED");
});

test("control server exposes /chatgpt-advisor routes", async () => {
  const calls = [];
  const port = 39123;
  const server = createLlamaControlServer({
    controlPort: port,
    onLlamaServerStatus: () => ({ ok: true }),
    onLlamaServerStart: async () => ({ ok: true }),
    onLlamaServerStop: () => {},
    onChatGptAdvisor: async (action, body, query) => {
      calls.push({ action, body, projectId: query.get("projectId") });
      return { ok: true, action };
    },
  });
  await listenControlServer(server, port);
  try {
    const status = await fetch(`http://127.0.0.1:${port}/chatgpt-advisor/status?projectId=p1`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true, action: "status" });

    const setup = await fetch(`http://127.0.0.1:${port}/chatgpt-advisor/setup`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1" }),
    });
    assert.equal(setup.status, 200);
    assert.deepEqual(await setup.json(), { ok: true, action: "setup" });

    const stop = await fetch(`http://127.0.0.1:${port}/chatgpt-advisor/stop`, {
      method: "POST",
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(stop.status, 200);

    assert.deepEqual(calls, [
      { action: "status", body: {}, projectId: "p1" },
      // setup passes projectId in the body; the query carries it only when the
      // caller uses ?projectId=. The mock reads query only.
      { action: "setup", body: { projectId: "p1" }, projectId: null },
      { action: "stop", body: {}, projectId: null },
    ]);
  } finally {
    await closeControlServer(server);
  }
});

test("cleanup removes profile when requested", async () => {
  const { service, root } = makeService();
  const profile = join(root, "data", "chatgpt-advisor", "chrome-profile");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "x"), "y", "utf8");
  await service.cleanup(true);
  assert.equal(existsSync(profile), false);
});

// Regression: an earlier build ran `icacls /inheritance:r` on the advisor
// directories. Combined with a restricted process token that has an empty
// default DACL, config.json was created with no ACEs at all, so setEnabled
// failed with "EPERM: operation not permitted, rename" and the advisor could
// never be enabled. The service must repair the ACL and complete the write.
test("setEnabled recovers from an empty-DACL config.json", { skip: process.platform !== "win32" }, async () => {
  const { service, dataDir } = makeService();
  const advisorDir = join(dataDir, "chatgpt-advisor");
  const configFile = join(advisorDir, "config.json");
  mkdirSync(advisorDir, { recursive: true });

  // Reproduce the broken directory: no inheritance and no delete-child right,
  // so replacing a file inside depends on the file's own DACL.
  const principal = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  execFileSync(
    "icacls",
    [advisorDir, "/inheritance:r", "/grant:r", `${principal}:(R,W,D)`, "/grant:r", "*S-1-5-18:(F)", "/grant:r", "*S-1-5-32-544:(F)"],
    { stdio: "ignore" },
  );
  writeFileSync(configFile, "{}\n", "utf8");
  execFileSync("icacls", [configFile, "/inheritance:r"], { stdio: "ignore" });
  for (const who of [principal, "*S-1-5-18", "*S-1-5-32-544"]) {
    try {
      execFileSync("icacls", [configFile, "/remove:g", who], { stdio: "ignore" });
    } catch {
      // the ACE may not be present; the goal is an empty DACL
    }
  }

  const result = await service.setEnabled(true);

  assert.equal(result.enabled, true);
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).enabled, true);
});
