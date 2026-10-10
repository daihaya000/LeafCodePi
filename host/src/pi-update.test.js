import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { spawnSync as realSpawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_PI_VERSION, PI_DEPS_LOCK_STALE_MS, PI_PACKAGES, assertPiDependencyVersions, piDepsLockHeld } from "../../shared/pi-dependencies.mjs";
import {
  autoUpdatePi, installedPiVersion, PI_UPDATE_TIMEOUT_MS, updatePiBeforeStartup,
  consumePiUpdateRequest, readPiUpdateRequest, readPiUpdateState, requestPiUpdate, writePiUpdateState,
} from "./pi-update.js";

function manifest(version) {
  return {
    dependencies: Object.fromEntries(PI_PACKAGES.map((name) => [name, version])),
    overrides: Object.fromEntries(PI_PACKAGES.map((name) => [name, `$${name}`])),
  };
}
function lockFor(data) {
  return { lockfileVersion: 3, packages: {
    "": { dependencies: data.dependencies },
    ...Object.fromEntries(PI_PACKAGES.map((name) => [`node_modules/${name}`, { version: data.dependencies[name] }])),
  } };
}
function installFake(dir, version) {
  for (const name of PI_PACKAGES) {
    const packageDir = join(dir, "node_modules", name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }));
  }
}
function fixture(initial = "0.99.2", backend = initial) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-pi-sync-"));
  const webDir = join(root, "web"), backendDir = join(root, "backend");
  mkdirSync(webDir); mkdirSync(backendDir);
  writeFileSync(join(webDir, "package.json"), JSON.stringify({ dependencies: { react: "19.1.0" } }));
  writeFileSync(join(webDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { react: "19.1.0" } }, "node_modules/react": { version: "19.1.0" } } }));
  mkdirSync(join(webDir, "node_modules"));
  writeFileSync(join(webDir, "node_modules", "untouched"), "Web dependencies remain untouched");
  writeFileSync(join(backendDir, "package.json"), `${JSON.stringify(manifest(backend), null, 2).replaceAll("\n", "\r\n")}\r\n`);
  writeFileSync(join(backendDir, "package-lock.json"), JSON.stringify(lockFor(manifest(backend))));
  installFake(backendDir, backend);
  const webBytes = ["package.json", "package-lock.json", "node_modules/untouched"].map(p => readFileSync(join(webDir, p)));
  return { root, webDir, backendDir, env: { LEAFCODE_PI_DATA_DIR: root }, runtimeIsIdle: () => true, cleanup: () => {
    if (existsSync(webDir)) {
      assert.deepEqual(["package.json", "package-lock.json", "node_modules/untouched"].map(p => readFileSync(join(webDir, p))), webBytes);
      assert.deepEqual(readdirSync(join(webDir, "node_modules")), ["untouched"]);
    }
    rmSync(root, { recursive: true, force: true });
  } };
}
function fakeNpm({ latest = ["0.100.0", "0.100.0"], intercept = () => {} } = {}) {
  const calls = [];
  function spawnSync(command, args, options) {
    calls.push({ command, args, options });
    const intercepted = intercept(command, args, options, calls);
    if (intercepted) return intercepted;
    if (args[0] === "view") {
      const index = PI_PACKAGES.findIndex((name) => args[1] === `${name}@latest`);
      return { status: 0, stdout: JSON.stringify([latest[index]]) };
    }
    if (args[0] === "install") {
      const data = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
      writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify(lockFor(data)));
    } else if (args[0] === "ci") {
      const data = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
      installFake(options.cwd, data.dependencies[PI_PACKAGES[0]]);
    }
    return { status: 0, stdout: "" };
  }
  return { calls, spawnSync };
}
function snapshot(f) {
  return [f.webDir, f.backendDir].map((dir) => ({
    manifest: readFileSync(join(dir, "package.json")),
    lock: readFileSync(join(dir, "package-lock.json")),
    versions: PI_PACKAGES.map((name) => installedPiVersion(dir, name)),
  }));
}
function assertClean(f) {
  for (const dir of [f.webDir, f.backendDir]) {
    assert.equal(readdirSync(dir).some((name) => name.startsWith(".leafcode-pi-")), false);
  }
}

test("latest SDK and AI are fetched once, pinned and installed for Backend before publication", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    const result = autoUpdatePi({ ...f, ...npm, platform: "win32" });
    assert.deepEqual(result, { attempted: true, updated: true, skipped: false, safeToStart: true, version: "0.100.0" });
    assert.equal(assertPiDependencyVersions(f.backendDir), "0.100.0");
    assert.deepEqual(npm.calls.map(({ args }) => args[0]), ["view", "view", "install", "ci", "--input-type=module"]);
    for (const call of npm.calls) {
      assert.ok(call.options.timeout > 0 && call.options.timeout <= PI_UPDATE_TIMEOUT_MS);
      if (call.args[0] === "view") assert.equal(call.command, "npm.cmd");
      else assert.notEqual(call.options.cwd, f.backendDir);
    }
    for (const dir of [f.backendDir]) {
      assert.deepEqual(PI_PACKAGES.map((name) => installedPiVersion(dir, name)), ["0.100.0", "0.100.0"]);
      const text = readFileSync(join(dir, "package.json"), "utf8");
      assert.equal(/(?<!\r)\n/.test(text), false, "existing CRLF preserved");
    }
    assertClean(f);
  } finally { f.cleanup(); }
});

test("the pinned default target installs the shipped version without asking npm for latest", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    const result = autoUpdatePi({ ...f, ...npm, targetVersion: DEFAULT_PI_VERSION });
    assert.equal(result.updated, true);
    assert.equal(result.version, DEFAULT_PI_VERSION);
    assert.deepEqual(npm.calls.map(({ args }) => args[0]), ["install", "ci", "--input-type=module"]);
    assert.equal(assertPiDependencyVersions(f.backendDir), DEFAULT_PI_VERSION);
    assertClean(f);
  } finally { f.cleanup(); }
});

test("an unstable pinned target is refused before npm runs", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    const before = snapshot(f);
    const result = autoUpdatePi({ ...f, ...npm, targetVersion: "1.0.0-rc.1" });
    assert.equal(result.updated, false);
    assert.match(result.error, /not a stable version/);
    assert.equal(npm.calls.length, 0);
    assert.deepEqual(snapshot(f), before);
  } finally { f.cleanup(); }
});

test("matching latest versions perform no install or dependency writes", () => {
  const f = fixture();
  const npm = fakeNpm({ latest: ["0.99.2", "0.99.2"] });
  try {
    const before = snapshot(f);
    const result = autoUpdatePi({ ...f, ...npm });
    assert.equal(result.updated, false);
    assert.equal(result.version, "0.99.2");
    assert.deepEqual(npm.calls.map(({ args }) => args[0]), ["view", "view"]);
    assert.deepEqual(snapshot(f), before);
    assertClean(f);
  } finally { f.cleanup(); }
});

test("an old AI beside a current SDK is repaired even when the SDK itself did not advance", () => {
  const f = fixture();
  const npm = fakeNpm({ latest: ["0.99.2", "0.99.2"] });
  try {
    const data = manifest("0.99.2");
    data.dependencies[PI_PACKAGES[1]] = "^0.87.0";
    writeFileSync(join(f.backendDir, "package.json"), JSON.stringify(data));
    installFake(f.backendDir, "0.87.1");
    const result = autoUpdatePi({ ...f, ...npm });
    assert.equal(result.updated, true);
    assert.equal(assertPiDependencyVersions(f.backendDir), "0.99.2");
    assert.deepEqual(PI_PACKAGES.map((name) => installedPiVersion(f.backendDir, name)), ["0.99.2", "0.99.2"]);
  } finally { f.cleanup(); }
});

test("any Backend mismatch is aligned to the chosen latest version, including a newer installed Backend", () => {
  const f = fixture("0.99.2", "0.101.0");
  const npm = fakeNpm();
  try {
    assert.equal(autoUpdatePi({ ...f, ...npm }).updated, true);
    assert.equal(assertPiDependencyVersions(f.backendDir), "0.100.0");
  } finally { f.cleanup(); }
});

test("different latest tags or a prerelease never cause a partial update", () => {
  for (const latest of [["0.100.0", "0.99.2"], ["0.100.0-rc.1", "0.100.0-rc.1"]]) {
    const f = fixture();
    try {
      const before = snapshot(f);
      const npm = fakeNpm({ latest });
      const result = autoUpdatePi({ ...f, ...npm });
      assert.equal(result.updated, false);
      assert.equal(result.safeToStart, true);
      assert.ok(result.error);
      assert.deepEqual(snapshot(f), before);
      assertClean(f);
    } finally { f.cleanup(); }
  }
});

test("network, install and module validation failures retain the previous Backend install", () => {
  for (const failAt of [1, 2, 3, 4, 5]) {
    const f = fixture();
    try {
      const before = snapshot(f);
      const npm = fakeNpm({ intercept: (_command, _args, _options, calls) => calls.length === failAt ? { status: 1 } : null });
      const result = autoUpdatePi({ ...f, ...npm });
      assert.equal(result.updated, false);
      assert.equal(result.safeToStart, true);
      assert.deepEqual(snapshot(f), before);
      assertClean(f);
    } finally { f.cleanup(); }
  }
});

test("a malformed staged lock cannot be published", () => {
  const f = fixture();
  try {
    const before = snapshot(f);
    const npm = fakeNpm({ intercept: (_command, args, options) => {
      if (args[0] !== "install") return null;
      writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify(lockFor(manifest("0.87.1"))));
      return { status: 0 };
    } });
    const result = autoUpdatePi({ ...f, ...npm });
    assert.equal(result.updated, false);
    assert.deepEqual(snapshot(f), before);
    assertClean(f);
  } finally { f.cleanup(); }
});

test("publication failure in the Backend rolls back its files and modules", () => {
  for (const operation of ["rename", "write"]) {
    const f = fixture();
    let failed = false;
    try {
      const before = snapshot(f);
      const fs = {
        renameSync: (from, to) => {
          if (operation === "rename" && !failed && to === join(f.backendDir, "node_modules")) {
            failed = true;
            throw new Error("rename refused");
          }
          renameSync(from, to);
        },
        writeFileSync: (path, content) => {
          if (operation === "write" && !failed && path === join(f.backendDir, "package-lock.json")) {
            failed = true;
            throw new Error("write refused");
          }
          writeFileSync(path, content);
        },
      };
      const result = autoUpdatePi({ ...f, ...fakeNpm(), fs });
      assert.equal(result.updated, false);
      assert.equal(result.safeToStart, true);
      assert.deepEqual(snapshot(f), before);
      assertClean(f);
    } finally { f.cleanup(); }
  }
});

test("rollback failure refuses startup and retains the affected backup", () => {
  const f = fixture();
  try {
    const result = autoUpdatePi({ ...f, ...fakeNpm(), fs: {
      renameSync: (from, to) => {
        if (to === join(f.backendDir, "node_modules")) throw new Error("locked modules");
        renameSync(from, to);
      }, writeFileSync,
    } });
    assert.equal(result.safeToStart, false);
    const retained = readdirSync(f.backendDir).find((name) => name.startsWith(".leafcode-pi-update-"));
    assert.ok(retained);
    assert.ok(existsSync(join(f.backendDir, retained, "previous-node_modules")));
  } finally { f.cleanup(); }
});

test("concurrent edits are preserved instead of overwritten by the prepared version", () => {
  const f = fixture();
  try {
    const changed = `${JSON.stringify({ ...manifest("0.99.2"), edited: true })}\n`;
    const npm = fakeNpm({ intercept: (_command, _args, _options, calls) => {
      if (calls.length === 5) writeFileSync(join(f.backendDir, "package.json"), changed);
    } });
    const result = autoUpdatePi({ ...f, ...npm });
    assert.equal(result.updated, false);
    assert.equal(readFileSync(join(f.backendDir, "package.json"), "utf8"), changed);
    assert.equal(installedPiVersion(f.backendDir), "0.99.2");
    assert.equal(installedPiVersion(f.backendDir), "0.99.2");
    assertClean(f);
  } finally { f.cleanup(); }
});

test("an existing synchronization lock never spawns npm", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), "other worker");
    assert.equal(autoUpdatePi({ ...f, ...npm }).updated, false);
    assert.equal(npm.calls.length, 0);
    assert.equal(readFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), "utf8"), "other worker");
  } finally { f.cleanup(); }
});

test("a dead-owner deps lock is reclaimed instead of bricking Host restart", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), JSON.stringify({ pid: 424_242 }));
    const result = autoUpdatePi({ ...f, ...npm });
    assert.equal(result.safeToStart, true);
    assert.equal(result.error, undefined);
    assert.equal(existsSync(join(f.backendDir, ".leafcode-pi-deps.lock")), false);
    assert.ok(npm.calls.length >= 2);
  } finally { f.cleanup(); }
});

test("build gates ignore a dead-owner deps lock but still refuse a live or opaque one", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), JSON.stringify({ pid: 424_242 }));
    assert.doesNotThrow(() => assertPiDependencyVersions(f.backendDir));
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), "worker");
    assert.throws(() => assertPiDependencyVersions(f.backendDir), /unfinished/);
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), JSON.stringify({ pid: process.pid }));
    assert.throws(() => assertPiDependencyVersions(f.backendDir), /unfinished/);
  } finally { f.cleanup(); }
});

test("a deps lock older than the stale limit is abandoned even when its PID looks alive", () => {
  const f = fixture();
  try {
    const lock = join(f.backendDir, ".leafcode-pi-deps.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    assert.equal(piDepsLockHeld(lock), true);
    const old = new Date(Date.now() - PI_DEPS_LOCK_STALE_MS - 60_000);
    utimesSync(lock, old, old);
    assert.equal(piDepsLockHeld(lock), false);
    assert.doesNotThrow(() => assertPiDependencyVersions(f.backendDir));
  } finally { f.cleanup(); }
});

test("manual updates are refused while a Host is running", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    writeFileSync(join(f.root, "host.lock"), JSON.stringify({ pid: process.pid }));
    const result = autoUpdatePi({ ...f, ...npm });
    assert.match(result.error, /Stop the Host/);
    assert.equal(npm.calls.length, 0);
  } finally { f.cleanup(); }
});

test("a live or unidentified orphan runtime prevents installation even without a Host lock", () => {
  const f = fixture();
  const npm = fakeNpm();
  try {
    const before = snapshot(f);
    const result = autoUpdatePi({ ...f, ...npm, runtimeIsIdle: () => false });
    assert.match(result.error, /listeners must be idle/);
    assert.deepEqual(npm.calls.map(({ args }) => args[0]), ["view", "view"]);
    assert.deepEqual(snapshot(f), before);
    assertClean(f);
  } finally { f.cleanup(); }
});

test("a runtime appearing during preparation prevents publication of the Backend install", () => {
  const f = fixture();
  let checks = 0;
  try {
    const before = snapshot(f);
    const result = autoUpdatePi({ ...f, ...fakeNpm(), runtimeIsIdle: () => ++checks === 1 });
    assert.match(result.error, /started during preparation/);
    assert.equal(checks, 2);
    assert.deepEqual(snapshot(f), before);
    assertClean(f);
  } finally { f.cleanup(); }
});

test("the deadline prevents another npm step and leaves Backend dependencies intact", () => {
  const f = fixture();
  let clock = 0;
  try {
    const before = snapshot(f);
    const npm = fakeNpm({ intercept: () => { clock += PI_UPDATE_TIMEOUT_MS; } });
    const result = autoUpdatePi({ ...f, ...npm, now: () => clock });
    assert.match(result.error, /timed out/);
    assert.equal(npm.calls.length, 1);
    assert.deepEqual(snapshot(f), before);
  } finally { f.cleanup(); }
});

test("startup awaits the worker and treats a missing completion message as unsafe", async () => {
  for (const reported of [true, false]) {
    const child = new EventEmitter();
    let settled = false;
    const pending = updatePiBeforeStartup({
      backendDir: "backend", env: {},
      spawn: (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(dirname(args[0]).endsWith("scripts"), true);
        assert.equal(options.stdio.at(-1), "ipc");
        return child;
      },
    }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false);
    if (reported) child.emit("message", { safeToStart: true, updated: true, version: "0.100.0" });
    child.emit("close", reported ? 0 : 1);
    assert.equal((await pending).safeToStart, reported);
  }
});

test("silent publication corruption is detected and rolled back", () => {
  const f = fixture();
  let corrupted = false;
  try {
    const before = snapshot(f);
    const result = autoUpdatePi({ ...f, ...fakeNpm(), fs: {
      renameSync,
      writeFileSync: (path, content) => {
        if (!corrupted && path === join(f.backendDir, "package.json")) {
          corrupted = true;
          writeFileSync(path, `${content}\n`);
        } else writeFileSync(path, content);
      },
    } });
    assert.equal(result.updated, false);
    assert.match(result.error, /published dependency bytes/);
    assert.deepEqual(snapshot(f), before);
  } finally { f.cleanup(); }
});

test("build gates reject a pending updater, missing overrides and mixed transitive locks", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), "worker");
    assert.throws(() => assertPiDependencyVersions(f.backendDir), /unfinished/);
    rmSync(join(f.backendDir, ".leafcode-pi-deps.lock"));
    const data = manifest("0.99.2");
    delete data.overrides[PI_PACKAGES[1]];
    writeFileSync(join(f.backendDir, "package.json"), JSON.stringify(data));
    assert.throws(() => assertPiDependencyVersions(f.backendDir), /override/);
    writeFileSync(join(f.backendDir, "package.json"), JSON.stringify(manifest("0.99.2")));
    const lock = lockFor(manifest("0.99.2"));
    lock.packages[`node_modules/plugin/node_modules/${PI_PACKAGES[1]}`] = { version: "0.87.1" };
    writeFileSync(join(f.backendDir, "package-lock.json"), JSON.stringify(lock));
    assert.throws(() => assertPiDependencyVersions(f.backendDir), /mixed locked/);
  } finally { f.cleanup(); }
});

test("the real CLI checks isolated fixtures without modifying them or reaching npm", () => {
  const f = fixture();
  try {
    const before = snapshot(f);
    const cli = new URL("../../scripts/sync-pi-dependencies.mjs", import.meta.url);
    const result = realSpawnSync(process.execPath, [fileURLToPath(cli), "--check", "--backend", f.backendDir], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /match v0\.99\.2/);
    assert.deepEqual(snapshot(f), before);
  } finally { f.cleanup(); }
});

test("a worker that never reports completion is stopped instead of blocking startup forever", async () => {
  const f = fixture();
  const child = new EventEmitter();
  child.pid = 4242;
  const killed = [];
  // A killed worker never runs its own cleanup, so it leaves the lock that every later start refuses.
  writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), JSON.stringify({ pid: child.pid }));
  try {
    const pending = updatePiBeforeStartup({
      backendDir: f.backendDir, env: {}, timeoutMs: 25,
      spawn: () => child,
      killTree: (pid) => { killed.push(pid); },
      isAlive: () => false,
      error: () => {},
    });
    const timedOut = await pending;
    // A completion message that arrives after the deadline must not resurrect the wedged startup.
    child.emit("message", { safeToStart: true, updated: true });
    child.emit("close", 0);
    assert.equal(timedOut.safeToStart, false);
    assert.match(timedOut.error, /did not report completion/);
    assert.deepEqual(killed, [4242]);
    assert.equal(existsSync(join(f.backendDir, ".leafcode-pi-deps.lock")), false);
    assert.doesNotThrow(() => assertPiDependencyVersions(f.backendDir));
  } finally { f.cleanup(); }
});

test("a timed-out worker that is still alive keeps the deps lock so a second sync cannot start", async () => {
  const f = fixture();
  const child = new EventEmitter();
  child.pid = 4244;
  writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), JSON.stringify({ pid: child.pid }));
  try {
    const timedOut = await updatePiBeforeStartup({
      backendDir: f.backendDir, env: {}, timeoutMs: 25,
      spawn: () => child,
      killTree: () => false,
      isAlive: () => true,
      error: () => {},
    });
    assert.equal(timedOut.safeToStart, false);
    assert.equal(existsSync(join(f.backendDir, ".leafcode-pi-deps.lock")), true);
    // The Host left the lock because it believes the worker is alive; use a real live pid so the
    // gate's ESRCH check matches that belief under unit-test PIDs.
    writeFileSync(join(f.backendDir, ".leafcode-pi-deps.lock"), JSON.stringify({ pid: process.pid }));
    assert.throws(() => assertPiDependencyVersions(f.backendDir), /unfinished/);
  } finally { f.cleanup(); }
});

test("a worker that reports in time is not killed", async () => {
  const child = new EventEmitter();
  child.pid = 4243;
  const killed = [];
  const pending = updatePiBeforeStartup({
    backendDir: "backend", env: {}, timeoutMs: 5_000,
    spawn: () => child,
    killTree: (pid) => { killed.push(pid); },
  });
  child.emit("message", { safeToStart: true, updated: false, version: "0.99.2" });
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.safeToStart, true);
  assert.equal(result.version, "0.99.2");
  assert.deepEqual(killed, []);
});

test("startup spawn throw and spawn error settle without launching a runtime", async () => {
  assert.equal((await updatePiBeforeStartup({ env: {}, spawn: () => { throw new Error("cannot spawn"); } })).safeToStart, false);
  const child = new EventEmitter();
  const pending = updatePiBeforeStartup({ env: {}, spawn: () => child });
  child.emit("error", new Error("cannot spawn"));
  assert.equal((await pending).safeToStart, false);
});

test("a requested default target reaches the synchronization worker", async () => {
  const child = new EventEmitter();
  let spawnedArgs;
  const pending = updatePiBeforeStartup({
    backendDir: "backend", env: {}, targetVersion: DEFAULT_PI_VERSION,
    spawn: (_command, args) => { spawnedArgs = args; return child; },
  });
  child.emit("message", { safeToStart: true, updated: true, version: DEFAULT_PI_VERSION });
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.safeToStart, true);
  assert.deepEqual(spawnedArgs.slice(-2), ["--target", DEFAULT_PI_VERSION]);
});

test("a Backend-only update does not require a Web source directory", () => {
  const f = fixture(), npm = fakeNpm();
  try {
    rmSync(f.webDir, { recursive: true });
    const result = autoUpdatePi({ ...f, targetVersion: "1.0.0", spawnSync: npm.spawnSync });
    assert.equal(result.updated, true);
    assert.equal(assertPiDependencyVersions(f.backendDir), "1.0.0");
    assert.equal(existsSync(f.webDir), false);
    assert.ok(npm.calls.every(call => call.options.cwd.startsWith(f.backendDir)));
    assert.match(npm.calls.at(-1).args[2], /better-sqlite3/);
  } finally { f.cleanup(); }
});

test("a live Web listener does not block Backend synchronization, but a live Backend does", async (t) => {
  const f = fixture(), web = createServer(), backend = createServer();
  t.after(async () => {
    if (web.listening) await new Promise(r => web.close(r));
    if (backend.listening) await new Promise(r => backend.close(r));
    f.cleanup();
  });
  await new Promise(r => web.listen(0, "127.0.0.1", r));
  await new Promise(r => backend.listen(0, "127.0.0.1", r));
  const webPort = web.address().port, backendPort = backend.address().port;
  const env = { ...f.env, LEAFCODE_PI_PORT: String(webPort), LEAFCODE_PI_BACKEND_PORT: String(backendPort) };
  {
    let npm = fakeNpm();
    const refused = autoUpdatePi({ ...f, env, runtimeIsIdle: undefined, targetVersion: "1.0.0", spawnSync: npm.spawnSync });
    assert.equal(refused.updated, false);
    assert.equal(npm.calls.length, 0);
    assert.match(refused.error, /Backend listeners/);
    await new Promise(r => backend.close(r));
    npm = fakeNpm();
    const updated = autoUpdatePi({ ...f, env, runtimeIsIdle: undefined, targetVersion: "1.0.0", spawnSync: npm.spawnSync });
    assert.equal(updated.updated, true);
    assert.equal(web.listening, true);
    assertClean(f);
  }
});

test("settings requests round-trip through the reservation and state files", () => {
  const f = fixture();
  try {
    assert.equal(readPiUpdateRequest(f.root), null);
    const request = requestPiUpdate(f.root, "default", { requestedAt: 123 });
    assert.deepEqual(request, { mode: "default", requestedAt: 123 });
    assert.deepEqual(readPiUpdateRequest(f.root), request);

    assert.throws(() => requestPiUpdate(f.root, "nightly"), /Unknown Pi update mode/);
    writeFileSync(join(f.root, "pi-update-request.json"), "{not json");
    assert.equal(readPiUpdateRequest(f.root), null);
    writeFileSync(join(f.root, "pi-update-request.json"), JSON.stringify({ mode: "nightly" }));
    assert.equal(readPiUpdateRequest(f.root), null, "unknown modes are ignored");

    requestPiUpdate(f.root, "default", { requestedAt: 123 });
    assert.deepEqual(consumePiUpdateRequest(f.root), { mode: "default", requestedAt: 123 });
    assert.equal(readPiUpdateRequest(f.root), null, "consumed exactly once");
    assert.equal(consumePiUpdateRequest(f.root), null);

    const state = { mode: "latest", ok: true, updated: true, version: "1.2.3" };
    writePiUpdateState(f.root, state);
    assert.deepEqual(readPiUpdateState(f.root), state);
  } finally { f.cleanup(); }
});
