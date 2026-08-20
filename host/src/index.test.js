import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { bindHost, isHeadless, readPort, shouldOpenBrowser } from "./config.js";
import { isThisModuleEntrypoint } from "./entry.js";
import { pidAlive, readLock, removeLock, writeLock } from "./lock.js";
import { formatLogLine } from "./log-file.js";
import { localLeafcodePiTempDir } from "./tray-temp.js";
import { formatWebStatus, getPostBuildLaunchPlan, getWebLaunchPlan } from "./web-plan.js";

test("readPort falls back on invalid values", () => {
  assert.equal(readPort("3000", 1), 3000);
  assert.equal(readPort("nope", 3000), 3000);
  assert.equal(readPort("0", 3000), 3000);
  assert.equal(readPort(undefined, 3000), 3000);
});

test("isHeadless reads env and argv", () => {
  assert.equal(isHeadless({}, []), false);
  assert.equal(isHeadless({ LEAFCODE_PI_HEADLESS: "1" }, []), true);
  assert.equal(isHeadless({}, ["node", "index.js", "--headless"]), true);
});

test("shouldOpenBrowser defaults on", () => {
  assert.equal(shouldOpenBrowser({}), true);
  assert.equal(shouldOpenBrowser({ LEAFCODE_PI_NO_BROWSER: "1" }), false);
});

test("bindHost defaults to loopback", () => {
  assert.equal(bindHost({}), "127.0.0.1");
  assert.equal(bindHost({ LEAFCODE_PI_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("getWebLaunchPlan prefers existing production build", () => {
  assert.deepEqual(getWebLaunchPlan(undefined, true), { needsBuild: false, useProd: true });
  assert.deepEqual(getWebLaunchPlan("dev", true), { needsBuild: false, useProd: false });
  assert.deepEqual(getWebLaunchPlan("prod", false), { needsBuild: true, useProd: true });
  assert.deepEqual(getWebLaunchPlan(undefined, false), { needsBuild: false, useProd: false });
});

test("getPostBuildLaunchPlan serves a successful build", () => {
  assert.deepEqual(getPostBuildLaunchPlan("prod", true), { needsBuild: false, useProd: true });
  assert.deepEqual(getPostBuildLaunchPlan("dev", true), { needsBuild: false, useProd: false });
});

test("formatWebStatus labels", () => {
  assert.equal(formatWebStatus({ building: true, running: false, httpUp: false }), "LeafCodePi: building...");
  assert.equal(formatWebStatus({ building: false, running: true, httpUp: true }), "LeafCodePi: running");
  assert.equal(formatWebStatus({ building: false, running: true, httpUp: false }), "LeafCodePi: starting...");
  assert.equal(formatWebStatus({ building: false, running: false, httpUp: false }), "LeafCodePi: stopped");
});

test("lock file round-trip and stale pid", () => {
  const files = new Map();
  const deps = {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => files.get(path),
    writeFileSync: (path, contents) => {
      if (files.has(path)) {
        const err = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      files.set(path, contents);
    },
    unlinkSync: (path) => files.delete(path),
  };
  writeLock("lock", 42, deps);
  assert.deepEqual(readLock("lock", deps), { pid: 42 });
  removeLock("lock", deps);
  assert.equal(readLock("lock", deps), null);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
});

test("log line is a single tab-separated row", () => {
  const line = formatLogLine({
    ts: Date.parse("2026-08-20T12:00:00.000Z"),
    source: "host",
    level: "log",
    text: "hello\nworld",
  });
  assert.equal(line, "2026-08-20T12:00:00.000Z\thost\tlog\thello world");
});

test("tray temp dir lives under LOCALAPPDATA", () => {
  assert.ok(localLeafcodePiTempDir({ LOCALAPPDATA: "C:\\Local" }).endsWith("leafcode-pi\\tmp") || localLeafcodePiTempDir({ LOCALAPPDATA: "C:\\Local" }).includes("leafcode-pi"));
});

test("isThisModuleEntrypoint matches relative and absolute argv", () => {
  const indexUrl = new URL("./index.js", import.meta.url);
  const abs = fileURLToPath(indexUrl);
  const relFromCwd = relative(process.cwd(), abs);
  assert.equal(isThisModuleEntrypoint(indexUrl.href, abs), true);
  assert.equal(isThisModuleEntrypoint(indexUrl.href, relFromCwd), true);
  assert.equal(isThisModuleEntrypoint(indexUrl.href, ""), false);
  assert.equal(isThisModuleEntrypoint(indexUrl.href, join("src", "index.test.js")), false);
});
