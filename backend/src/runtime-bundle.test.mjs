import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, "..", "runtime", "runtime.bundle.mjs");

/**
 * The bundle is a build artifact (`npm run build:backend-runtime`), so these tests only run when it
 * has been built. A missing bundle means "not built yet", not a failure: the Backend still starts and
 * serves transport without a runtime.
 */
const RUNTIME_API = [
  "promptTask",
  "getTaskDetail",
  "getTaskDetailReadOnly",
  "abortTask",
  "listPendingAttention",
  "pendingPermissionForTask",
  "pendingQuestionForTask",
  "respondToPermissionPrompt",
  "respondToQuestionPrompt",
  "clearPendingAttentionForTask",
  "startBotCodeRelay",
  "applyCodePermissionSettingsToLiveTasks",
];

test("the built runtime bundle exposes the Backend's runtime API", { skip: !existsSync(BUNDLE) }, async () => {
  const runtime = await import(pathToFileURL(BUNDLE).href);
  const missing = RUNTIME_API.filter((name) => typeof runtime[name] !== "function");
  assert.deepEqual(missing, [], "every runtime entry point must be exported");
});

test("the bundle is loadable from a plain Node process", { skip: !existsSync(BUNDLE) }, async () => {
  // Importing is the assertion: the module graph must not need a Next server or a build step, and the
  // external Pi SDK must resolve from this project's own dependency.
  const runtime = await import(pathToFileURL(BUNDLE).href);
  assert.equal(typeof runtime.promptTask, "function");
  assert.equal(typeof runtime.getTaskDetail, "function");
});

test("the runtime entry source and build script exist", () => {
  const root = resolve(HERE, "..", "..");
  assert.ok(existsSync(join(root, "scripts", "build-backend-runtime.mjs")), "build script is missing");
  assert.ok(existsSync(join(root, "web", "src", "lib", "pi", "backend-runtime-entry.ts")), "runtime entry is missing");
});
