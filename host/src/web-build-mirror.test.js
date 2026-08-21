import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  mirrorDistDir,
  mirrorSlug,
  resolveMirrorRoot,
  sourceEntryKind,
  syncMirror,
} from "../../scripts/web-build-mirror.mjs";
import {
  discardPreviousBuild,
  previousBuildDir,
  productionWebUiIsIdle,
  restorePreviousBuild,
  stashPreviousBuild,
  webUiPort,
} from "../../scripts/build-web.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "lcp-mirror-"));
  return { root, source: join(root, "web"), mirror: join(root, "mirror") };
}

test("the mirror never lives inside the mirrored project", () => {
  const { root, source } = sandbox();
  try {
    mkdirSync(source, { recursive: true });
    assert.throws(
      () => syncMirror({ sourceDir: source, mirrorRoot: join(source, "inner") }),
      /must not live inside the project/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncMirror copies sources across and skips .git / .next", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, ".git"), { recursive: true });
    mkdirSync(join(source, ".next"), { recursive: true });
    writeFileSync(join(source, "src", "page.tsx"), "export default null;\n");
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(source, ".next", "BUILD_ID"), "stale\n");

    const result = syncMirror({ sourceDir: source, mirrorRoot: mirror });

    assert.equal(readFileSync(join(mirror, "src", "page.tsx"), "utf8"), "export default null;\n");
    assert.throws(() => readFileSync(join(mirror, ".git", "HEAD")), /ENOENT/);
    assert.throws(() => readFileSync(join(mirror, ".next", "BUILD_ID")), /ENOENT/);
    assert.equal(result.distDir, join(mirror, ".next"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncMirror preserves the mirror's own build output while pruning removed sources", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "keep.ts"), "1\n");
    writeFileSync(join(source, "gone.ts"), "2\n");
    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    // A previous build in the mirror must survive the next sync.
    mkdirSync(join(mirror, ".next"), { recursive: true });
    writeFileSync(join(mirror, ".next", "BUILD_ID"), "good\n");
    rmSync(join(source, "gone.ts"));

    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    assert.equal(readFileSync(join(mirror, ".next", "BUILD_ID"), "utf8"), "good\n");
    assert.throws(() => readFileSync(join(mirror, "gone.ts")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tsconfig.json is copied, not hard-linked, so a build cannot rewrite the repository", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "tsconfig.json"), '{"original":true}\n');
    writeFileSync(join(source, "src.ts"), "1\n");
    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    // `next build` rewrites tsconfig.json in the project it builds.
    writeFileSync(join(mirror, "tsconfig.json"), '{"rewritten":true}\n');

    assert.equal(readFileSync(join(source, "tsconfig.json"), "utf8"), '{"original":true}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMirrorRoot prefers the explicit override, then LOCALAPPDATA", () => {
  assert.equal(
    resolveMirrorRoot({ LEAFCODE_PI_BUILD_DIR: "C:\\tmp\\mirror" }, "C:\\repo\\web"),
    "C:\\tmp\\mirror",
  );
  assert.equal(
    resolveMirrorRoot({ LOCALAPPDATA: "C:\\local" }, "C:\\repo\\web"),
    join("C:\\local", "leafcode-pi", "build", mirrorSlug("C:\\repo\\web")),
  );
});

test("mirrorSlug is stable per checkout and differs between checkouts", () => {
  assert.equal(mirrorSlug("C:\\repo\\web"), mirrorSlug("c:/REPO/web"));
  assert.notEqual(mirrorSlug("C:\\repo-a\\web"), mirrorSlug("C:\\repo-b\\web"));
});

test("mirrorDistDir stays inside the mirrored project (Turbopack rejects an outside distDir)", () => {
  assert.equal(mirrorDistDir("C:\\local\\build\\x"), join("C:\\local\\build\\x", ".next"));
});

test("OneDrive cloud files are mirrored, real symlinks are skipped", () => {
  const cloudFile = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
  const asFile = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  const asLink = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
  assert.equal(sourceEntryKind(cloudFile, asFile), "file");
  assert.equal(sourceEntryKind(cloudFile, asLink), "skip");
  assert.equal(sourceEntryKind(cloudFile, null), "skip");
  assert.equal(sourceEntryKind(asFile, null), "file");
});

test("a failed rebuild restores the previous production build", () => {
  const { root } = sandbox();
  try {
    const distDir = join(root, ".next");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "BUILD_ID"), "good\n");

    assert.equal(stashPreviousBuild(distDir), true);
    assert.equal(readFileSync(join(previousBuildDir(distDir), "BUILD_ID"), "utf8"), "good\n");

    // The failed build leaves junk behind; restoring must replace it wholesale.
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "partial"), "junk\n");
    assert.equal(restorePreviousBuild(distDir), true);
    assert.equal(readFileSync(join(distDir, "BUILD_ID"), "utf8"), "good\n");
    assert.throws(() => readFileSync(join(distDir, "partial")), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful rebuild discards the stashed build", () => {
  const { root } = sandbox();
  try {
    const distDir = join(root, ".next");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "BUILD_ID"), "old\n");
    stashPreviousBuild(distDir);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "BUILD_ID"), "new\n");

    assert.equal(discardPreviousBuild(distDir), true);
    assert.equal(readFileSync(join(distDir, "BUILD_ID"), "utf8"), "new\n");
    assert.equal(restorePreviousBuild(distDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stash/restore are no-ops when there is nothing to move", () => {
  const { root } = sandbox();
  try {
    const distDir = join(root, "absent");
    assert.equal(stashPreviousBuild(distDir), false);
    assert.equal(restorePreviousBuild(distDir), false);
    assert.equal(discardPreviousBuild(distDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const MIRROR = "C:\\local\\leafcode-pi\\build\\leafcodepi-abcd1234";
const NETSTAT = "  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       4242\n";

/** netstat first, then the per-PID command line lookup. */
function execStub(commandLine, netstat = NETSTAT) {
  return (cmd) => (cmd === "netstat" ? netstat : commandLine);
}

test("the build guard refuses while next start serves the mirror", () => {
  const serving = execStub(`node ${MIRROR}\\node_modules\\next\\dist\\bin\\next start --port 3010`);
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: serving }), false);
});

test("the build guard allows a rebuild while next dev holds the port", () => {
  // dev serves the repository's own output, which the mirror build never touches.
  const dev = execStub("node C:\\repo\\web\\node_modules\\next\\dist\\bin\\next dev --port 3010");
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: dev }), true);
});

test("the build guard ignores an unrelated next start from another checkout", () => {
  const other = execStub("node C:\\other\\web\\node_modules\\next\\dist\\bin\\next start --port 3010");
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: other }), true);
});

test("the build guard fails closed when a listener cannot be identified", () => {
  const opaque = (cmd) => {
    if (cmd === "netstat") return NETSTAT;
    throw new Error("access denied");
  };
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: opaque }), false);
});

test("the build guard allows a rebuild when the port is free", () => {
  const idle = execStub("", "  TCP    127.0.0.1:9999   0.0.0.0:0   LISTENING   4242\n");
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: idle }), true);
});

test("the build guard does not block when netstat is unavailable", () => {
  const broken = () => {
    throw new Error("netstat missing");
  };
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: broken }), true);
});

test("webUiPort falls back to 3010 for absent or invalid values", () => {
  assert.equal(webUiPort({ LEAFCODE_PI_PORT: "3100" }), 3100);
  assert.equal(webUiPort({}), 3010);
  assert.equal(webUiPort({ LEAFCODE_PI_PORT: "nope" }), 3010);
  assert.equal(webUiPort({ LEAFCODE_PI_PORT: "70000" }), 3010);
});

test("the host builds through build-web.mjs and serves the mirror", () => {
  const source = readFileSync(join(REPO_ROOT, "host", "src", "index.js"), "utf8");
  assert.match(source, /scripts", "build-web\.mjs"\), "--skip-guard"/);
  assert.match(source, /const WEB_DIST_DIR = mirrorDistDir\(WEB_MIRROR_DIR\)/);
  assert.match(source, /const projectDir = useProd \? WEB_MIRROR_DIR : WEB_DIR/);
});
