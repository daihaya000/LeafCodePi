import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mirrorSlug, resolveMirrorRoot } from "../../scripts/build-workspace.mjs";
import { ensureExtensionDependencies, extensionDependenciesReady, extensionDependencyFingerprint } from "../../scripts/extension-dependencies.mjs";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("extension dependencies repair locked and unlocked manifests with missing packages", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-ext-deps-"));
  try {
    const manifest = JSON.stringify({ dependencies: { linkedom: "^0.16.0" } });
    const lock = "{}";
    const extension = (name, files) => {
      mkdirSync(join(root, name), { recursive: true });
      for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), text);
    };
    extension("missing", { "package.json": `\uFEFF${manifest}`, "package-lock.json": lock });
    extension("installed", { "package.json": manifest, "package-lock.json": lock });
    mkdirSync(join(root, "installed", "node_modules", "linkedom"), { recursive: true });
    writeFileSync(join(root, "installed", "node_modules", "linkedom", "package.json"), "{}");
    writeFileSync(
      join(root, "installed", "node_modules", ".leafcode-pi-build-deps"),
      extensionDependencyFingerprint(join(root, "installed")),
    );
    extension("unlocked", { "package.json": manifest });
    extension("no-deps", { "package.json": "{}" });
    extension("failing", { "package.json": manifest, "package-lock.json": lock });
    const calls = [];
    const install = (command, args, options) => {
      calls.push(options.cwd);
      assert.equal(command, process.platform === "win32" ? "npm.cmd" : "npm");
      assert.equal(options.shell, process.platform === "win32");
      const unlocked = options.cwd.endsWith("unlocked");
      assert.deepEqual(args, [...(unlocked ? ["install", "--no-save"] : ["ci"]), "--include=dev", "--no-audit", "--no-fund"]);
      if (options.cwd.endsWith("failing")) return { status: 1 };
      mkdirSync(join(options.cwd, "node_modules", "linkedom"), { recursive: true });
      writeFileSync(join(options.cwd, "node_modules", "linkedom", "package.json"), "{}");
      return { status: 0 };
    };
    assert.deepEqual(ensureExtensionDependencies(root, { install }), ["missing", "unlocked"]);
    assert.deepEqual(calls.sort(), [join(root, "failing"), join(root, "missing"), join(root, "unlocked")]);
    assert.equal(
      existsSync(join(root, "missing", "node_modules", ".leafcode-pi-build-deps")),
      true,
      "a successful install writes the deps stamp",
    );
    assert.equal(existsSync(join(root, "unlocked", "package-lock.json")), false);
    assert.deepEqual(ensureExtensionDependencies(root, { install }), []);
    assert.equal(calls.filter((dir) => !dir.endsWith("failing")).length, 2, "healthy packages must not reinstall");
    assert.deepEqual(ensureExtensionDependencies(join(root, "absent"), { install }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension dependencies reinstall when the lock fingerprint is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-ext-deps-stale-"));
  try {
    const dir = join(root, "stale");
    mkdirSync(join(dir, "node_modules", "linkedom"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { linkedom: "^0.16.0" } }));
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":1}');
    writeFileSync(join(dir, "node_modules", "linkedom", "package.json"), "{}");
    writeFileSync(join(dir, "node_modules", ".leafcode-pi-build-deps"), "stale-fingerprint");
    let calls = 0;
    const install = (_command, args) => {
      calls += 1;
      assert.deepEqual(args, ["install", "--no-save", "--include=dev", "--no-audit", "--no-fund"]);
      return { status: 0 };
    };
    assert.deepEqual(ensureExtensionDependencies(root, { install }), ["stale"]);
    assert.equal(calls, 1);
    assert.equal(
      readFileSync(join(dir, "node_modules", ".leafcode-pi-build-deps"), "utf8"),
      extensionDependencyFingerprint(dir),
    );
    assert.deepEqual(ensureExtensionDependencies(root, { install }), []);
    assert.equal(calls, 1, "matching stamp must not reinstall");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension repair preserves a live native module when another dependency is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-ext-deps-live-"));
  try {
    const dir = join(root, "leafcode-memory");
    const nativeDir = join(dir, "node_modules", "better-sqlite3");
    mkdirSync(nativeDir, { recursive: true });
    const manifest = JSON.stringify({ dependencies: { "better-sqlite3": "12.9.0", "strip-ansi": "7.2.0" } });
    writeFileSync(join(dir, "package.json"), manifest);
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(nativeDir, "package.json"), "{}");
    const nativeFile = join(nativeDir, "better_sqlite3.node");
    writeFileSync(nativeFile, "live-native-module");
    const stamp = join(dir, "node_modules", ".leafcode-pi-build-deps");
    writeFileSync(stamp, extensionDependencyFingerprint(dir));
    let calls = 0;
    const install = (_command, args) => {
      calls += 1;
      assert.deepEqual(args, ["install", "--no-save", "--include=dev", "--no-audit", "--no-fund"]);
      assert.equal(readFileSync(nativeFile, "utf8"), "live-native-module");
      mkdirSync(join(dir, "node_modules", "strip-ansi"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "strip-ansi", "package.json"), "{}");
      return { status: 0 };
    };
    const probeNative = () => ({ status: 0 });
    assert.deepEqual(ensureExtensionDependencies(root, { install, probeNative }), ["leafcode-memory"]);
    assert.deepEqual(ensureExtensionDependencies(root, { install, probeNative }), []);
    assert.equal(calls, 1);
    assert.equal(readFileSync(nativeFile, "utf8"), "live-native-module");
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), manifest);
    assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful npm exit without restored packages must not write a dependency stamp", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-ext-deps-incomplete-"));
  try {
    const dir = join(root, "incomplete");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "strip-ansi": "7.2.0" } }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    assert.deepEqual(ensureExtensionDependencies(root, { install: () => ({ status: 0 }) }), []);
    assert.equal(existsSync(join(dir, "node_modules", ".leafcode-pi-build-deps")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native SQLite health is checked in a bounded child even with a matching stamp", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-ext-deps-native-"));
  try {
    const dir = join(root, "leafcode-memory");
    mkdirSync(join(dir, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "better-sqlite3": "12.9.0" } }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "node_modules", "better-sqlite3", "package.json"), "{}");
    const stamp = join(dir, "node_modules", ".leafcode-pi-build-deps");
    writeFileSync(stamp, extensionDependencyFingerprint(dir));
    let healthy = false;
    let installs = 0;
    let rebuilds = 0;
    const probeNative = (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.match(args[1], /new Database\(':memory:'\)\.close\(\)/);
      assert.equal(options.cwd, dir);
      assert.equal(options.timeout, 10_000);
      assert.equal(options.stdio, "ignore");
      assert.equal(options.windowsHide, true);
      return { status: healthy ? 0 : 1 };
    };
    const install = (_command, args) => {
      if (args[0] === "rebuild") {
        rebuilds += 1;
        assert.deepEqual(args, ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"]);
      } else {
        installs += 1;
        assert.equal(args[0], "install");
      }
      return { status: 0 };
    };
    assert.equal(extensionDependenciesReady(dir, ["better-sqlite3"], { probeNative }), false);
    assert.deepEqual(ensureExtensionDependencies(root, { install, probeNative }), []);
    assert.equal(installs, 1, "a matching stamp must not hide a broken native module");
    assert.equal(rebuilds, 1, "npm success alone must not hide a failed native rebuild");
    assert.deepEqual(ensureExtensionDependencies(root, { probeNative, install: (...args) => {
      const result = install(...args);
      healthy = true;
      return result;
    } }), ["leafcode-memory"]);
    assert.deepEqual(ensureExtensionDependencies(root, { install, probeNative }), []);
    assert.equal(installs, 2, "healthy native module must not reinstall");
    assert.equal(extensionDependenciesReady(dir, ["better-sqlite3"], {
      probeNative: () => ({ status: null, error: new Error("probe timed out") }),
    }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension recovery rebuilds a missing native binding when npm install leaves it broken", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-ext-deps-rebuild-"));
  try {
    const dir = join(root, "leafcode-memory");
    mkdirSync(join(dir, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "better-sqlite3": "12.9.0" } }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "node_modules", "better-sqlite3", "package.json"), "{}");
    let healthy = false;
    const calls = [];
    const install = (_command, args) => {
      calls.push(args[0]);
      if (args[0] === "rebuild") healthy = true;
      return { status: 0 };
    };
    const probeNative = () => ({ status: healthy ? 0 : 1 });
    assert.deepEqual(ensureExtensionDependencies(root, { install, probeNative }), ["leafcode-memory"]);
    assert.deepEqual(calls, ["install", "rebuild"]);
    assert.deepEqual(ensureExtensionDependencies(root, { install, probeNative }), []);
    assert.deepEqual(calls, ["install", "rebuild"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMirrorRoot prefers the explicit override, then LOCALAPPDATA", () => {
  const override = join(tmpdir(), "lcp-explicit-mirror");
  const source = join(tmpdir(), "lcp-repo", "web");
  assert.equal(
    resolveMirrorRoot({ LEAFCODE_PI_BUILD_DIR: override }, source),
    resolve(override),
  );
  const local = join(tmpdir(), "lcp-localappdata");
  assert.equal(
    resolveMirrorRoot({ LOCALAPPDATA: local }, source),
    join(local, "leafcode-pi", "build", mirrorSlug(source)),
  );
  const cache = join(tmpdir(), "lcp-xdg-cache");
  assert.equal(
    resolveMirrorRoot({ XDG_CACHE_HOME: cache }, source),
    join(cache, "leafcode-pi", "build", mirrorSlug(source)),
  );
});

test("resolveMirrorRoot has a home cache fallback when no cache env is set", () => {
  const source = join(REPO_ROOT, "web");
  assert.equal(
    resolveMirrorRoot({}, source),
    join(homedir(), ".cache", "leafcode-pi", "build", mirrorSlug(source)),
  );
});

test("mirrorSlug is stable per checkout and differs between checkouts", () => {
  assert.equal(mirrorSlug("C:\\repo\\web", "win32"), mirrorSlug("c:/REPO/web", "win32"));
  assert.notEqual(mirrorSlug("C:\\repo-a\\web", "win32"), mirrorSlug("C:\\repo-b\\web", "win32"));
  assert.notEqual(mirrorSlug("/home/A/LeafCodePi/web", "linux"), mirrorSlug("/home/a/LeafCodePi/web", "linux"));
});

test("the host builds through build-web.mjs and serves the mirror", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  assert.match(source, /scripts", "spa-build-generation\.mjs"/);
  assert.match(source, /const SPA_MIRROR_DIR = resolveSpaMirrorRoot/);
  assert.match(source, /launchProductionGateway/);
  assert.doesNotMatch(source, /nextBin\(|ensureBuildDependencies\(WEB_MIRROR_DIR\)/);
  const webPackage = JSON.parse(readFileSync(join(REPO_ROOT, "web", "package.json"), "utf8"));
  assert.equal(webPackage.scripts.build, "node ../scripts/build-web.mjs");
});

test("production uses the repo-owned computer-use helper, not the web build mirror", () => {
  const host = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  const helper = readFileSync(join(REPO_ROOT, "extensions", "leafcode-computer-use", "src", "platform", "windows", "helper.ts"), "utf8");
  const executable = join(REPO_ROOT, "extensions", "leafcode-computer-use", "prebuilt", "windows", "windows-bridge.exe");
  assert.match(host, /LEAFCODE_PI_EXTENSIONS_DIR: join\(REPO_ROOT, "extensions"\)/);
  assert.match(helper, /path\.join\(PACKAGE_ROOT, "prebuilt", "windows", "windows-bridge\.exe"\)/);
  assert.equal(
    createHash("sha256").update(readFileSync(executable)).digest("hex").toUpperCase(),
    "D3EF7E59BC03C421D6D29DE53750C343CC1BB2F126AA23224241FDFD5C3A7094",
  );
});

test("quit stops the WebUI without building", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  const quitSource = source.slice(
    source.indexOf("async function quit()"),
    source.indexOf("function onHostExit()"),
  );
  assert.match(quitSource, /await stopWeb\(\)/);
  assert.doesNotMatch(quitSource, /activeBuild|quitPlan|buildWeb\(/);
});

test("a WebUI that stayed up returns its crash-restart budget", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  const spawnSource = source.slice(
    source.indexOf("async function spawnWeb("),
    source.indexOf("function scheduleWebRestart()"),
  );
  // The budget stops a rapid crash loop, so an unrelated crash hours later
  // must still be restartable: a process that stays up resets the counter.
  assert.match(spawnSource, /RESTART_BUDGET_RESET_MS/);
  assert.match(spawnSource, /webRestarts = 0/);
  assert.match(spawnSource, /clearTimeout\(stableTimer\)/);
});

test("a tray that stayed up returns its crash-restart budget", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  const traySource = source.slice(
    source.indexOf("function wireTrayLifecycle("),
    source.indexOf("async function startTray()"),
  );
  assert.match(traySource, /clearTimeout\(stableTimer\)/);
  const startSource = source.slice(
    source.indexOf("async function startTray()"),
    source.indexOf("function acquireLock()"),
  );
  assert.match(startSource, /trayRestarts = 0/);
  assert.match(startSource, /RESTART_BUDGET_RESET_MS/);
});

test("acquireLock refuses to remove an unreadable host.lock without a confirmed dead owner", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  const lockSource = source.slice(
    source.indexOf("function acquireLock()"),
    source.indexOf("async function startControlServer()"),
  );
  assert.match(lockSource, /existsSync\(LOCK_FILE\)/);
  assert.match(lockSource, /if \(!owner\) \{[\s\S]*?throw new Error\("Cannot safely reclaim host\.lock"\);/);
  assert.match(lockSource, /Removing stale unreadable host\.lock for PID \$\{owner\.pid\}/);
});

test("acquireLock stores and checks the process start key", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  const lockSource = source.slice(
    source.indexOf("function acquireLock()"),
    source.indexOf("async function startControlServer()"),
  );
  assert.match(lockSource, /const processKey = processStartKey\(process\.pid\)/);
  assert.match(lockSource, /lockOwnerAlive\(owner, \{ getProcessKey: processStartKey \}\)/);
  assert.match(lockSource, /writeLock\(LOCK_FILE, process\.pid, \{ processKey \}\)/);
});
