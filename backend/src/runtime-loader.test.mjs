import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
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

test("the generation is derived from the bundle bytes", async () => {
  const runtime = completeRuntime();
  const bytes = Buffer.from("bundle-contents", "utf8");
  const result = await loadBackendRuntime({
    exists: () => true,
    importModule: async () => runtime,
    readBytes: () => bytes,
  });
  const expected = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  assert.equal(result.generation, expected);
  // Different bytes are a different generation: a rebuild is not the running one.
  const rebuilt = await loadBackendRuntime({
    exists: () => true,
    importModule: async () => runtime,
    readBytes: () => Buffer.from("bundle-contents-v2", "utf8"),
  });
  assert.notEqual(rebuilt.generation, result.generation);
});

test("an unreadable bundle still loads, with an unknown generation", async () => {
  const runtime = completeRuntime();
  const result = await loadBackendRuntime({
    exists: () => true,
    importModule: async () => runtime,
    readBytes: () => { throw new Error("EACCES C:/private/bundle.mjs"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.generation, null);
  assert.equal(JSON.stringify(result).includes("EACCES"), false);
});

test("the default path points at the build artifact", () => {
  assert.equal(DEFAULT_RUNTIME_BUNDLE, resolve(HERE, "..", "runtime", "runtime.bundle.mjs"));
});

test("the built bundle loads with every required export", { skip: !existsSync(DEFAULT_RUNTIME_BUNDLE) }, async () => {
  const result = await loadBackendRuntime();
  assert.equal(result.ok, true, result.ok ? "" : `reason=${result.reason} missing=${result.missing?.join(",")}`);
  // Exercise the real bundled entry without starting a session or calling a provider.
  await assert.rejects(
    result.runtime.startGoalLoopWithSelection("not-a-task", { goal: "", auto: true }),
    (error) => error.status === 400 && error.message === "goal または acceptance が不正です",
  );
});
