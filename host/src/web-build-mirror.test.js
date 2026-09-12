import assert from "node:assert/strict";
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
  ensureBuildDependencies,
  handOffToServedWebUi,
  hostControlUrl,
  previousBuildDir,
  productionWebUiIsIdle,
  restorePreviousBuild,
  replantBuildCache,
  stashPreviousBuild,
  waitForWebUiHealth,
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
    for (const target of [source, join(source, "inner"), root]) {
      assert.throws(
        () => syncMirror({ sourceDir: source, mirrorRoot: target }),
        /must not live inside the project/,
      );
    }
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

test("repository-owned web files are copied so build tooling can mutate them", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "public"), { recursive: true });
    writeFileSync(join(source, "package.json"), "{}\n");
    writeFileSync(join(source, "src", "page.tsx"), "export default null;\n");
    writeFileSync(join(source, "public", "icon.svg"), "<svg/>\n");
    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    for (const path of ["package.json", join("src", "page.tsx"), join("public", "icon.svg")]) {
      const repoStat = lstatSync(join(source, path));
      const mirrorStat = lstatSync(join(mirror, path));
      assert.equal(repoStat.nlink, 1);
      assert.notEqual(repoStat.ino, mirrorStat.ino);
    }

    writeFileSync(join(mirror, "src", "page.tsx"), "export default function Page() { return null; }\n");
    assert.equal(readFileSync(join(source, "src", "page.tsx"), "utf8"), "export default null;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncMirror refreshes a same-size file when its mtime was preserved", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(source, { recursive: true });
    const sourceFile = join(source, "TaskView.tsx");
    const mirrorFile = join(mirror, "TaskView.tsx");
    writeFileSync(sourceFile, "old-content\n");
    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    const mirrorStat = statSync(mirrorFile);
    writeFileSync(sourceFile, "new-content\n");
    utimesSync(sourceFile, mirrorStat.atime, mirrorStat.mtime);

    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    assert.equal(readFileSync(mirrorFile, "utf8"), "new-content\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncMirror migrates existing linked repository files to independent copies", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), "{}\n");
    mkdirSync(mirror, { recursive: true });
    linkSync(join(source, "package.json"), join(mirror, "package.json"));
    assert.equal(lstatSync(join(source, "package.json")).nlink, 2);

    syncMirror({ sourceDir: source, mirrorRoot: mirror });

    assert.equal(lstatSync(join(source, "package.json")).nlink, 1);
    assert.notEqual(
      lstatSync(join(source, "package.json")).ino,
      lstatSync(join(mirror, "package.json")).ino,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncMirror never syncs source dependencies and preserves local dependencies and caches", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    for (let i = 0; i < 128; i += 1) {
      writeFileSync(join(source, "node_modules", "pkg", `${i}.js`), "source dependency\n");
    }
    writeFileSync(join(source, "page.tsx"), "export default null;\n");
    for (const dir of ["node_modules", "node_modules.prev", ".next", ".next.prev"]) {
      mkdirSync(join(mirror, dir), { recursive: true });
      writeFileSync(join(mirror, dir, "keep"), "workspace-owned\n");
    }
    writeFileSync(join(mirror, "tsconfig.tsbuildinfo"), "cached types\n");

    const first = syncMirror({ sourceDir: source, mirrorRoot: mirror });
    assert.equal(first.copied, 1);
    for (let i = 0; i < 3; i += 1) {
      const result = syncMirror({ sourceDir: source, mirrorRoot: mirror });
      assert.equal(result.copied, 0);
      assert.equal(result.unchanged, 1);
      assert.equal(result.removed, 0);
    }
    assert.equal(existsSync(join(mirror, "node_modules", "pkg")), false);
    assert.equal(lstatSync(join(source, "node_modules", "pkg", "0.js")).nlink, 1);
    assert.equal(readFileSync(join(mirror, "node_modules", "keep"), "utf8"), "workspace-owned\n");
    assert.equal(readFileSync(join(mirror, "tsconfig.tsbuildinfo"), "utf8"), "cached types\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function installNextFixture(_command, _args, { cwd }) {
  for (const file of ["bin/next", "compiled/commander/index.js"]) {
    const path = join(cwd, "node_modules", "next", "dist", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// local dependency\n");
  }
  const sqlite = join(cwd, "node_modules", "better-sqlite3", "index.js");
  mkdirSync(dirname(sqlite), { recursive: true });
  writeFileSync(sqlite, "module.exports = class Database { close() {} };\n");
  return { status: 0 };
}

test("dependencies migrate once, stay local across source syncs, and refresh when manifests or CLI change", () => {
  const { root, source, mirror } = sandbox();
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), "{}\n");
    writeFileSync(join(source, "package-lock.json"), '{"version":1}\n');
    installNextFixture(null, null, { cwd: source });
    const from = join(source, "node_modules", "next", "dist", "bin", "next");
    const to = join(mirror, "node_modules", "next", "dist", "bin", "next");
    mkdirSync(dirname(to), { recursive: true });
    linkSync(from, to);
    let calls = 0;
    const install = (command, args, options) => {
      calls += 1;
      assert.equal(options.cwd, mirror);
      assert.equal(options.shell, process.platform === "win32");
      assert.equal(command, process.platform === "win32" ? "npm.cmd" : "npm");
      assert.deepEqual(args, ["ci", "--include=dev", "--no-audit", "--no-fund"]);
      assert.equal(existsSync(to), false, "legacy dependencies were moved aside before npm ci");
      return installNextFixture(command, args, options);
    };
    syncMirror({ sourceDir: source, mirrorRoot: mirror });
    assert.equal(ensureBuildDependencies(mirror, { install }), true);
    assert.equal(lstatSync(from).nlink, 1);
    assert.notEqual(lstatSync(from).ino, lstatSync(to).ino);
    writeFileSync(to, "// independent local dependency\n");
    writeFileSync(join(source, "page.tsx"), "export default null;\n");
    syncMirror({ sourceDir: source, mirrorRoot: mirror });
    assert.equal(ensureBuildDependencies(mirror, { install }), false);
    assert.equal(readFileSync(from, "utf8"), "// local dependency\n");
    assert.equal(readFileSync(to, "utf8"), "// independent local dependency\n");
    assert.equal(calls, 1);

    for (const manifest of ["package.json", "package-lock.json"]) {
      writeFileSync(join(source, manifest), '{"version":2}\n');
      syncMirror({ sourceDir: source, mirrorRoot: mirror });
      assert.equal(ensureBuildDependencies(mirror, { install }), true);
    }
    rmSync(to);
    assert.equal(ensureBuildDependencies(mirror, { install }), true);
    assert.equal(calls, 4);
    assert.equal(existsSync(join(mirror, "node_modules.prev")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed dependency installs restore legacy dependencies and leave the previous build intact", () => {
  const { root, mirror } = sandbox();
  try {
    mkdirSync(join(mirror, ".next"), { recursive: true });
    writeFileSync(join(mirror, "package.json"), "{}\n");
    writeFileSync(join(mirror, "package-lock.json"), "{}\n");
    writeFileSync(join(mirror, ".next", "BUILD_ID"), "good\n");
    installNextFixture(null, null, { cwd: mirror });
    for (const failure of [{ status: 1 }, { error: new Error("spawn failed") }, { status: 0 }, { status: 0, brokenSqlite: true }]) {
      assert.throws(() => ensureBuildDependencies(mirror, { install: () => {
        mkdirSync(join(mirror, "node_modules"), { recursive: true });
        writeFileSync(join(mirror, "node_modules", "partial"), "junk\n");
        if (failure.brokenSqlite) {
          installNextFixture(null, null, { cwd: mirror });
          writeFileSync(join(mirror, "node_modules", "better-sqlite3", "index.js"),
            "module.exports = class Database { constructor() { process.exit(1); } };\n");
        }
        return failure;
      } }), /npm ci|spawn failed|SQLite/);
      assert.equal(existsSync(join(mirror, "node_modules", "partial")), false);
      assert.equal(existsSync(join(mirror, "node_modules", ".leafcode-pi-build-deps")), false);
      assert.equal(existsSync(join(mirror, "node_modules", "next", "dist", "bin", "next")), true);
      assert.equal(readFileSync(join(mirror, ".next", "BUILD_ID"), "utf8"), "good\n");
    }
    rmSync(join(mirror, "node_modules"), { recursive: true, force: true });
    assert.throws(() => ensureBuildDependencies(mirror, { install: () => ({ status: 1 }) }), /npm ci/);
    assert.equal(existsSync(join(mirror, "node_modules")), false);
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

test("replantBuildCache warms the rebuild while keeping outputs stashed", () => {
  const { root } = sandbox();
  try {
    const distDir = join(root, ".next");
    const prevDir = join(root, ".next.prev");
    mkdirSync(join(prevDir, "cache"), { recursive: true });
    writeFileSync(join(prevDir, "cache", "pack"), "turbopack\n");
    writeFileSync(join(prevDir, "BUILD_ID"), "good\n");

    assert.equal(replantBuildCache(distDir), true);
    assert.equal(readFileSync(join(distDir, "cache", "pack"), "utf8"), "turbopack\n");
    assert.equal(readFileSync(join(prevDir, "BUILD_ID"), "utf8"), "good\n");
    // Second call is a no-op: the cache already sits in the fresh output dir.
    assert.equal(replantBuildCache(distDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replantBuildCache is a no-op without a stashed cache", () => {
  const { root } = sandbox();
  try {
    assert.equal(replantBuildCache(join(root, "absent")), false);
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
  assert.equal(productionWebUiIsIdle({ platform: "win32", port: 3010, mirrorRoot: MIRROR, exec: serving }), false);
});

test("the build guard allows a rebuild while next dev holds the port", () => {
  // dev serves the repository's own output, which the mirror build never touches.
  const dev = execStub("node C:\\repo\\web\\node_modules\\next\\dist\\bin\\next dev --port 3010");
  assert.equal(productionWebUiIsIdle({ platform: "win32", port: 3010, mirrorRoot: MIRROR, exec: dev }), true);
});

test("the build guard ignores an unrelated next start from another checkout", () => {
  const other = execStub("node C:\\other\\web\\node_modules\\next\\dist\\bin\\next start --port 3010");
  assert.equal(productionWebUiIsIdle({ platform: "win32", port: 3010, mirrorRoot: MIRROR, exec: other }), true);
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

test("the build guard fails closed when netstat is unavailable", () => {
  const broken = () => {
    throw new Error("netstat missing");
  };
  assert.equal(productionWebUiIsIdle({ port: 3010, mirrorRoot: MIRROR, exec: broken }), false);
});

test("the Linux build guard refuses an unidentified ss listener", () => {
  const exec = (command) => {
    if (command === "ss") return "LISTEN 0 128 127.0.0.1:3010 0.0.0.0:*";
    throw new Error(`unexpected command: ${command}`);
  };
  assert.equal(
    productionWebUiIsIdle({ platform: "linux", port: 3010, mirrorRoot: MIRROR, exec }),
    false,
  );
});

test("the Linux build guard uses ss and ps", () => {
  const calls = [];
  const commandLine = `/usr/bin/node ${MIRROR}/node_modules/next/dist/bin/next start --hostname 127.0.0.1`;
  const exec = (command) => {
    calls.push(command);
    if (command === "ss") {
      return `LISTEN 0 128 127.0.0.1:3010 0.0.0.0:* users:(("node",pid=4242,fd=1))`;
    }
    if (command === "ps") return commandLine;
    throw new Error(`unexpected command: ${command}`);
  };
  assert.equal(
    productionWebUiIsIdle({ platform: "linux", port: 3010, mirrorRoot: MIRROR, exec }),
    false,
  );
  assert.deepEqual(calls, ["ss", "ps"]);
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
  assert.match(source, /ensureBuildDependencies\(WEB_MIRROR_DIR\)/);
  const webPackage = JSON.parse(readFileSync(join(REPO_ROOT, "web", "package.json"), "utf8"));
  assert.equal(webPackage.scripts.build, "node ../scripts/build-web.mjs");
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

test("hostControlUrl prefers the running host's file, then the default port", () => {
  const file = () => JSON.stringify({ url: "http://127.0.0.1:18999/" });
  assert.equal(hostControlUrl({ APPDATA: "C:\\data" }, file), "http://127.0.0.1:18999");
  assert.equal(
    hostControlUrl({ APPDATA: "C:\\data", LEAFCODE_PI_HOST_CONTROL_URL: "http://127.0.0.1:1/" }, file),
    "http://127.0.0.1:1",
  );
  const missing = () => {
    throw new Error("ENOENT");
  };
  assert.equal(hostControlUrl({ APPDATA: "C:\\data" }, missing), "http://127.0.0.1:18775");
  assert.equal(
    hostControlUrl({ APPDATA: "C:\\data", LEAFCODE_PI_HOST_CONTROL_PORT: "18900" }, missing),
    "http://127.0.0.1:18900",
  );
});

test("a build that replaced a served .next asks the host to restart the WebUI", async () => {
  const calls = [];
  const post = async (url, init) => {
    calls.push([url, init?.method]);
    return { ok: true, status: 202 };
  };
  const get = async (url) => {
    calls.push([url, "GET"]);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const result = await handOffToServedWebUi({
    port: 3010,
    isIdle: () => false,
    controlUrl: "http://127.0.0.1:18775",
    post,
    get,
  });
  assert.equal(result, "restarted");
  assert.deepEqual(calls, [
    ["http://127.0.0.1:18775/restart/webui", "POST"],
    ["http://127.0.0.1:3010/api/health", "GET"],
  ]);
});

test("health check failure after restart returns manual", async () => {
  const post = async () => ({ ok: true, status: 202 });
  const get = async () => ({ ok: false, status: 503 });
  assert.equal(
    await handOffToServedWebUi({
      port: 3010,
      isIdle: () => false,
      controlUrl: "http://127.0.0.1:18775",
      post,
      get,
      healthTimeoutMs: 200,
      healthIntervalMs: 50,
    }),
    "manual",
  );
});

test("waitForWebUiHealth succeeds when /api/health returns ok", async () => {
  const get = async () => ({ ok: true, json: async () => ({ ok: true }) });
  assert.equal(await waitForWebUiHealth({ port: 3010, get, timeoutMs: 1000, intervalMs: 10 }), true);
});

test("no WebUI is serving the mirror: nothing is restarted", async () => {
  const post = async () => {
    throw new Error("must not be called");
  };
  assert.equal(await handOffToServedWebUi({ port: 3010, isIdle: () => true, post }), "idle");
});

test("an unreachable host degrades to a manual restart notice", async () => {
  const refused = async () => ({ ok: false, status: 501 });
  assert.equal(
    await handOffToServedWebUi({
      port: 3010,
      isIdle: () => false,
      controlUrl: "http://127.0.0.1:18775",
      post: refused,
    }),
    "manual",
  );
});
