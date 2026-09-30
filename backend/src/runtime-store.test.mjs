import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, "..", "runtime", "runtime.bundle.mjs");

/**
 * The bundle is a build artifact, so these tests only run when it has been built.
 *
 * They exercise the runtime against a *temporary* data directory: the bundle resolves the same
 * application paths the Backend does, so pointing `LEAFCODE_PI_DATA_DIR` at a temp directory keeps
 * the live store, sessions and credentials untouched.
 */
const skip = !existsSync(BUNDLE);

function fixture(t, tasks) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-backend-runtime-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "store.json"),
    `${JSON.stringify({ version: 1, projects: [], tasks })}\n`,
    "utf8",
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, data };
}

const task = (id, extra = {}) => ({
  id,
  projectId: null,
  projectName: "プロジェクトなし",
  title: "runtime probe",
  directory: "/tmp",
  isolation: "current_folder",
  status: "idle",
  sessionId: null,
  sessionFile: null,
  providerID: "test",
  modelID: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

/** Runs a body with the runtime pointed at a temp data directory, restoring the environment. */
async function withDataDir(data, body) {
  const previous = process.env.LEAFCODE_PI_DATA_DIR;
  const previousEnv = process.env.NODE_ENV;
  process.env.LEAFCODE_PI_DATA_DIR = data;
  // The path helpers refuse non-temp directories during tests; the temp dir satisfies them.
  process.env.NODE_ENV = "test";
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previous;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
}

test("the bundle reads a task detail from a Backend-owned data directory", { skip }, async (t) => {
  const { data } = fixture(t, [task("task-1")]);
  const runtime = await import(pathToFileURL(BUNDLE).href);
  const detail = await withDataDir(data, () => runtime.getTaskDetail("task-1", { offline: true }));
  assert.equal(detail.id, "task-1");
  assert.equal(detail.title, "runtime probe");
  assert.equal(detail.status, "idle");
  assert.deepEqual(detail.messages, [], "a task without a session file has no transcript");
  assert.equal(detail.isStreaming, false);
});

test("a missing task is reported as a coded refusal, not a crash", { skip }, async (t) => {
  const { data } = fixture(t, []);
  const runtime = await import(pathToFileURL(BUNDLE).href);
  await withDataDir(data, async () => {
    await assert.rejects(
      () => runtime.getTaskDetail("missing", { offline: true }),
      (error) => error.status === 404,
    );
  });
});

test("the runtime does not read the live data directory during these tests", { skip }, async (t) => {
  const { data } = fixture(t, [task("task-1")]);
  const runtime = await import(pathToFileURL(BUNDLE).href);
  await withDataDir(data, async () => {
    // A task that only exists in the temp store is found, which proves the override took effect.
    const detail = await runtime.getTaskDetail("task-1", { offline: true });
    assert.equal(detail.id, "task-1");
  });
  assert.equal(process.env.LEAFCODE_PI_DATA_DIR === data, false, "the environment is restored");
});
