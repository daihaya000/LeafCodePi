import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  bindHost,
  findTailscaleIPv4,
  isHeadless,
  isTailscaleCgnatIPv4,
  publicHost,
  readPort,
  shouldOpenBrowser,
  webUiUrl,
} from "./config.js";
import { isThisModuleEntrypoint } from "./entry.js";
import { pidAlive, readLock, removeLock, writeLock } from "./lock.js";
import { formatLogLine } from "./log-file.js";
import { localLeafcodePiTempDir } from "./tray-temp.js";
import { formatWebStatus, getPostBuildLaunchPlan, getWebLaunchPlan, isWebBuildStale } from "./web-plan.js";

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

test("bindHost resolves tailscale or falls back to loopback", () => {
  assert.equal(bindHost({}, { findTailscale: () => null }), "127.0.0.1");
  assert.equal(bindHost({ LEAFCODE_PI_HOST: "tailscale" }, { findTailscale: () => "100.64.1.2" }), "100.64.1.2");
  assert.equal(bindHost({ LEAFCODE_PI_HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(bindHost({ LEAFCODE_PI_HOST: "192.168.1.10" }), "192.168.1.10");
});

test("isTailscaleCgnatIPv4 and findTailscaleIPv4", () => {
  assert.equal(isTailscaleCgnatIPv4("100.64.0.1"), true);
  assert.equal(isTailscaleCgnatIPv4("100.127.255.255"), true);
  assert.equal(isTailscaleCgnatIPv4("100.63.0.1"), false);
  assert.equal(isTailscaleCgnatIPv4("10.0.0.1"), false);
  assert.equal(
    findTailscaleIPv4({
      Ethernet: [{ address: "192.168.1.2", family: "IPv4", internal: false }],
      Tailscale: [{ address: "100.100.50.1", family: "IPv4", internal: false }],
    }),
    "100.100.50.1",
  );
  assert.equal(
    findTailscaleIPv4({
      "Ethernet 2": [{ address: "100.64.9.9", family: 4, internal: false }],
    }),
    "100.64.9.9",
  );
});

test("publicHost never exposes 0.0.0.0", () => {
  assert.equal(publicHost("0.0.0.0", { findTailscale: () => null }), "127.0.0.1");
  assert.equal(publicHost("0.0.0.0", { findTailscale: () => "100.64.1.2" }), "100.64.1.2");
  assert.equal(webUiUrl("100.64.1.2", 3010), "http://100.64.1.2:3010");
});

test("getWebLaunchPlan prefers existing production build", () => {
  assert.deepEqual(getWebLaunchPlan(undefined, true), { needsBuild: false, useProd: true });
  assert.deepEqual(getWebLaunchPlan("dev", true), { needsBuild: false, useProd: false });
  assert.deepEqual(getWebLaunchPlan("prod", false), { needsBuild: true, useProd: true });
  assert.deepEqual(getWebLaunchPlan(undefined, false), { needsBuild: false, useProd: false });
});

test("getWebLaunchPlan rebuilds when BUILD_ID exists but sources are newer", () => {
  assert.deepEqual(getWebLaunchPlan("prod", true, true), { needsBuild: true, useProd: true });
  assert.deepEqual(getWebLaunchPlan("prod", true, false), { needsBuild: false, useProd: true });
  assert.deepEqual(getWebLaunchPlan(undefined, true, true), { needsBuild: true, useProd: true });
  assert.deepEqual(getWebLaunchPlan("dev", true, true), { needsBuild: false, useProd: false });
});

test("getPostBuildLaunchPlan serves a successful build", () => {
  assert.deepEqual(getPostBuildLaunchPlan("prod", true), {
    needsBuild: false,
    useProd: true,
    staleAfterBuild: false,
  });
  assert.deepEqual(getPostBuildLaunchPlan("dev", true), {
    needsBuild: false,
    useProd: false,
    staleAfterBuild: false,
  });
});

test("getPostBuildLaunchPlan never re-requests a build after a fresh build", () => {
  assert.deepEqual(getPostBuildLaunchPlan("prod", true, true), {
    needsBuild: false,
    useProd: true,
    staleAfterBuild: true,
  });
});

test("isWebBuildStale is true when a watched source is newer than BUILD_ID", () => {
  const buildMs = 1_000;
  const newer = 2_000;
  const files = new Map([
    ["web/.next/BUILD_ID", { mtimeMs: buildMs, isFile: () => true, isDirectory: () => false }],
    ["web/src/app/page.tsx", { mtimeMs: newer, isFile: () => true, isDirectory: () => false }],
    ["web/src", { mtimeMs: newer, isFile: () => false, isDirectory: () => true }],
    ["web/src/app", { mtimeMs: newer, isFile: () => false, isDirectory: () => true }],
  ]);
  const children = new Map([
    ["web/src", ["app"]],
    ["web/src/app", ["page.tsx"]],
  ]);
  const fsApi = {
    existsSync: (path) => files.has(normalize(path)),
    statSync: (path) => files.get(normalize(path)),
    readdirSync: (path) => children.get(normalize(path)) ?? [],
  };
  assert.equal(isWebBuildStale("web", "web/.next", fsApi), true);
});

test("isWebBuildStale is false when sources are older than BUILD_ID", () => {
  const buildMs = 2_000;
  const older = 1_000;
  const files = new Map([
    ["web/.next/BUILD_ID", { mtimeMs: buildMs, isFile: () => true, isDirectory: () => false }],
    ["web/package.json", { mtimeMs: older, isFile: () => true, isDirectory: () => false }],
    ["web/src", { mtimeMs: older, isFile: () => false, isDirectory: () => true }],
  ]);
  const children = new Map([["web/src", []]]);
  const fsApi = {
    existsSync: (path) => files.has(normalize(path)),
    statSync: (path) => files.get(normalize(path)),
    readdirSync: (path) => children.get(normalize(path)) ?? [],
  };
  assert.equal(isWebBuildStale("web", "web/.next", fsApi), false);
});

function normalize(path) {
  return String(path).replace(/\\/g, "/");
}

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
