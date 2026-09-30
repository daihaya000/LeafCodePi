import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { existsSync } from "node:fs";
import {
  DEFAULT_RUNTIME_BUNDLE,
  loadBackendRuntime,
  REQUIRED_RUNTIME_EXPORTS,
} from "./runtime-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const completeRuntime = () =>
  Object.fromEntries(REQUIRED_RUNTIME_EXPORTS.map((name) => [name, () => {}]));

test("a missing bundle is reported, not thrown", async () => {
  const result = await loadBackendRuntime({ exists: () => false });
  assert.deepEqual(result, { ok: false, reason: "missing" });
});

test("a bundle built from an older entry lists what it lacks", async () => {
  const runtime = completeRuntime();
  delete runtime.promptTask;
  const result = await loadBackendRuntime({
    exists: () => true,
    importModule: async () => runtime,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incomplete");
  assert.deepEqual(result.missing, ["promptTask"]);
});

test("a bundle that cannot be imported reports no exception text", async () => {
  const secret = "sk-secret-credential";
  const result = await loadBackendRuntime({
    exists: () => true,
    importModule: async () => {
      throw new Error(`failed to load C:/private/path ${secret}`);
    },
  });
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a complete bundle is returned as the runtime", async () => {
  const runtime = completeRuntime();
  const result = await loadBackendRuntime({ exists: () => true, importModule: async () => runtime });
  assert.equal(result.ok, true);
  assert.equal(result.runtime, runtime);
});

test("the default path points at the build artifact", () => {
  assert.equal(DEFAULT_RUNTIME_BUNDLE, resolve(HERE, "..", "runtime", "runtime.bundle.mjs"));
});

test("the built bundle loads with every required export", { skip: !existsSync(DEFAULT_RUNTIME_BUNDLE) }, async () => {
  const result = await loadBackendRuntime();
  assert.equal(result.ok, true, result.ok ? "" : `reason=${result.reason} missing=${result.missing?.join(",")}`);
});
