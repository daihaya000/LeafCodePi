import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  backendRuntimeBundleIsCurrent,
  backendRuntimeSourceStamp,
} from "./build-backend-runtime.mjs";

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
    const options = { roots: [entry, core, shared], webPackage, backendPackage };
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
