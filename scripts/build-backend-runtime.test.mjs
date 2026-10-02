import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  backendRuntimeBundleIsCurrent,
  backendRuntimeSourceStamp,
} from "./build-backend-runtime.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");
const HARNESS = join(ROOT, "web", "src", "lib", "pi", "harness.ts");
const ENTRY = join(ROOT, "web", "src", "lib", "pi", "backend-runtime-entry.ts");

test("backend runtime stamp changes when a source file changes and matches a written stamp", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-runtime-stamp-"));
  try {
    const entry = join(root, "entry.ts");
    const core = join(root, "core");
    const shared = join(root, "shared");
    mkdirSync(core);
    mkdirSync(shared);
    writeFileSync(entry, "export {}\n");
    writeFileSync(join(core, "a.mjs"), "export {}\n");
    writeFileSync(join(shared, "b.mjs"), "export {}\n");
    const webPackage = join(root, "web.json");
    const backendPackage = join(root, "backend.json");
    writeFileSync(webPackage, "{}\n");
    writeFileSync(backendPackage, "{}\n");
    const options = {
      roots: [entry, core, shared],
      webPackage,
      backendPackage,
      webLock: join(root, "missing-web-lock.json"),
      backendLock: join(root, "missing-backend-lock.json"),
      buildScript: join(root, "missing-build.mjs"),
    };
    const first = backendRuntimeSourceStamp(options);
    assert.match(first, /^[a-f0-9]{40}$/);
    writeFileSync(join(core, "a.mjs"), "export const changed = true;\n");
    const second = backendRuntimeSourceStamp(options);
    assert.notEqual(first, second);
    const bundlePath = join(root, "runtime.bundle.mjs");
    const stampPath = `${bundlePath}.stamp`;
    writeFileSync(bundlePath, "// bundle\n");
    writeFileSync(stampPath, `${second}\n`);
    assert.equal(backendRuntimeBundleIsCurrent({ bundlePath, stampPath, sourceStamp: second }), true);
    assert.equal(backendRuntimeBundleIsCurrent({ bundlePath, stampPath, sourceStamp: first }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default stamp covers harness.ts and is broader than entry-only", () => {
  assert.equal(statSync(HARNESS).isFile(), true);
  const defaultStamp = backendRuntimeSourceStamp();
  const entryOnly = backendRuntimeSourceStamp({
    roots: [ENTRY],
    webPackage: join(ROOT, "web", "package.json"),
    backendPackage: join(ROOT, "backend", "package.json"),
    webLock: join(ROOT, "missing-web-lock.json"),
    backendLock: join(ROOT, "missing-backend-lock.json"),
    buildScript: join(ROOT, "missing-build.mjs"),
  });
  assert.notEqual(defaultStamp, entryOnly, "default roots must include more than the entry file");

  const before = backendRuntimeSourceStamp();
  const st = statSync(HARNESS);
  const nextMtime = (st.mtimeMs / 1000) + 2;
  utimesSync(HARNESS, nextMtime, nextMtime);
  try {
    const after = backendRuntimeSourceStamp();
    assert.notEqual(before, after, "touching harness.ts must invalidate the default stamp");
  } finally {
    utimesSync(HARNESS, st.atimeMs / 1000, st.mtimeMs / 1000);
  }
});

test("default stamp changes when a lockfile or the build script changes", () => {
  const root = mkdtempSync(join(tmpdir(), "lcp-runtime-lock-stamp-"));
  try {
    const entry = join(root, "entry.ts");
    writeFileSync(entry, "export {}\n");
    const webPackage = join(root, "web.json");
    const backendPackage = join(root, "backend.json");
    const webLock = join(root, "web-lock.json");
    const backendLock = join(root, "backend-lock.json");
    const buildScript = join(root, "build.mjs");
    writeFileSync(webPackage, "{}\n");
    writeFileSync(backendPackage, "{}\n");
    writeFileSync(webLock, "{}\n");
    writeFileSync(backendLock, "{}\n");
    writeFileSync(buildScript, "export {}\n");
    const options = {
      roots: [entry],
      webPackage,
      backendPackage,
      webLock,
      backendLock,
      buildScript,
    };
    const first = backendRuntimeSourceStamp(options);
    writeFileSync(webLock, '{"lockfileVersion":1}\n');
    assert.notEqual(first, backendRuntimeSourceStamp(options), "web lockfile must be stamped");
    writeFileSync(webLock, "{}\n");
    writeFileSync(buildScript, "// banner change\n");
    assert.notEqual(first, backendRuntimeSourceStamp(options), "build script must be stamped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
