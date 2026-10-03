import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBackendWithFallback } from "./backend-build.js";

test("Backend restart forces compilation and retains the previous bundle on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcp-backend-fallback-"));
  try {
    const bundlePath = join(dir, "runtime.bundle.mjs");
    writeFileSync(bundlePath, "previous build");
    const logs = [];
    const result = await buildBackendWithFallback({
      force: true, bundlePath, error: (message) => logs.push(message),
      build: async ({ force }) => {
        assert.equal(force, true);
        throw new Error("compile failed");
      },
    });
    assert.equal(result.fallback, true);
    assert.equal(readFileSync(bundlePath, "utf8"), "previous build");
    assert.match(logs[0], /starting the previous build/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Backend build fails closed when there is no previous bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcp-backend-missing-"));
  try {
    await assert.rejects(buildBackendWithFallback({
      bundlePath: join(dir, "missing.mjs"),
      build: async () => { throw new Error("compile failed"); },
    }), /compile failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
