import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  formatWebStatus,
  getPostBuildLaunchPlan,
  getWebLaunchPlan,
  isWebBuildStale,
  procRunning,
  staleRebuildFailureAction,
} from "./web-plan.js";

/** モジュール側は join() でパスを組み立てるため、テスト側も同一の join を使う。 */
const WEB_DIR = join(process.cwd(), "web-fixture");
const DIST_DIR = join(WEB_DIR, ".next");
const path = (...parts) => join(WEB_DIR, ...parts);

function fakeFs({ files = {}, dirs = {} } = {}) {
  const stat = (p) => ({
    mtimeMs: files[p] ?? 0,
    isFile: () => Object.hasOwn(files, p),
    isDirectory: () => Object.hasOwn(dirs, p),
  });
  const api = {
    existsSync: (p) => Object.hasOwn(files, p) || Object.hasOwn(dirs, p),
    statSync: stat,
    readdirSync: (p) => dirs[p] ?? [],
  };
  api.files = files;
  api.dirs = dirs;
  return api;
}

test("getWebLaunchPlan chooses prod when a build exists", () => {
  assert.deepEqual(getWebLaunchPlan(undefined, true), { needsBuild: false, useProd: true });
  assert.deepEqual(getWebLaunchPlan("prod", false), { needsBuild: true, useProd: true });
  assert.deepEqual(getWebLaunchPlan("dev", true), { needsBuild: false, useProd: false });
  assert.deepEqual(getWebLaunchPlan(undefined, false), { needsBuild: false, useProd: false });
  assert.deepEqual(getWebLaunchPlan("prod", true, true), { needsBuild: true, useProd: true });
});

test("getPostBuildLaunchPlan ignores staleness inside the build", () => {
  assert.deepEqual(getPostBuildLaunchPlan("prod", true, true), {
    needsBuild: false,
    useProd: true,
    staleAfterBuild: true,
  });
});

test("staleRebuildFailureAction keeps a stale build only when appropriate", () => {
  assert.equal(
    staleRebuildFailureAction({ rebuildReason: "stale", hasBuild: true, stillStale: false, mode: "prod" }),
    "continue-stale",
  );
  assert.equal(
    staleRebuildFailureAction({ rebuildReason: "stale", hasBuild: true, stillStale: true, mode: "prod" }),
    "fail",
  );
  assert.equal(
    staleRebuildFailureAction({ rebuildReason: "other", hasBuild: true, stillStale: true, mode: "prod" }),
    "fallback-dev",
  );
  assert.equal(
    staleRebuildFailureAction({ rebuildReason: "stale", hasBuild: false, stillStale: true, mode: "prod" }),
    "fallback-dev",
  );
});

test("isWebBuildStale reports newer root and src files", () => {
  const buildMtime = 1000;
  const fs = fakeFs({
    files: {
      [join(DIST_DIR, "BUILD_ID")]: buildMtime,
      [path("src", "a.ts")]: 900,
      [path("package.json")]: 1100,
    },
    dirs: {
      [WEB_DIR]: [".next", "src", "package.json"],
      [path("src")]: ["a.ts"],
      [DIST_DIR]: ["BUILD_ID"],
    },
  });
  assert.equal(isWebBuildStale(WEB_DIR, DIST_DIR, fs), true); // package.json newer
  fs.files[path("package.json")] = 900;
  assert.equal(isWebBuildStale(WEB_DIR, DIST_DIR, fs), false); // all older
  fs.files[path("src", "a.ts")] = 1100;
  assert.equal(isWebBuildStale(WEB_DIR, DIST_DIR, fs), true); // src file newer
});

test("isWebBuildStale skips node_modules, dotfiles, and ignored extensions", () => {
  const fs = fakeFs({
    files: {
      [join(DIST_DIR, "BUILD_ID")]: 1000,
      [path("src", "README.md")]: 5000, // not a watched extension
      [path("src", ".env")]: 5000, // dotfile
      [path("node_modules", "x.js")]: 5000, // node_modules
      [path("src", "logo.png")]: 5000, // not a watched extension
    },
    dirs: {
      [WEB_DIR]: ["src", "node_modules", ".next"],
      [path("src")]: ["README.md", ".env", "logo.png"],
      [path("node_modules")]: ["x.js"],
      [DIST_DIR]: ["BUILD_ID"],
    },
  });
  assert.equal(isWebBuildStale(WEB_DIR, DIST_DIR, fs), false);
});

test("isWebBuildStale returns false without a BUILD_ID", () => {
  const fs = fakeFs({
    files: { [path("package.json")]: 5000 },
    dirs: { [WEB_DIR]: ["package.json"], [DIST_DIR]: [] },
  });
  assert.equal(isWebBuildStale(WEB_DIR, DIST_DIR, fs), false);
});

test("formatWebStatus and procRunning", () => {
  assert.equal(formatWebStatus({ building: true }), "LeafCodePi: building...");
  assert.equal(
    formatWebStatus({ building: false, running: true, httpUp: true }),
    "LeafCodePi: running",
  );
  assert.equal(formatWebStatus({}), "LeafCodePi: stopped");
  assert.equal(procRunning(null), false);
  assert.equal(procRunning({ exitCode: 0 }), false);
  assert.equal(procRunning({ exitCode: null, killed: false }), true);
  assert.equal(procRunning({ exitCode: null, killed: true }), false);
});