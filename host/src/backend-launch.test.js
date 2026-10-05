import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKEND_ENTRY_RELATIVE_PATH,
  RUNTIME_BUNDLE_RELATIVE_PATH,
  backendClientEnv,
  backendLaunchPlan,
  bundleGeneration,
} from "./backend-launch.js";

const REPO_ROOT = join("C:", "repo");

test("the generation hash is reused while mtime and size are unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-backend-plan-cache-"));
  try {
    const bundle = join(dir, "runtime.bundle.mjs");
    const pinned = 1_700_000_000; // whole seconds survive utimes without rounding
    writeFileSync(bundle, "export const a = 1;\n", "utf8");
    utimesSync(bundle, pinned, pinned);
    const first = bundleGeneration(bundle);
    // Same mtime and size, different bytes: only a cache can return the old hash.
    writeFileSync(bundle, "export const a = 2;\n", "utf8");
    utimesSync(bundle, pinned, pinned);
    assert.equal(bundleGeneration(bundle), first);
    // A different size is a rebuild.
    writeFileSync(bundle, "export const a = 22;\n", "utf8");
    assert.notEqual(bundleGeneration(bundle), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generation is the bundle hash, and a missing bundle has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-backend-plan-"));
  try {
    const bundle = join(dir, "runtime.bundle.mjs");
    assert.equal(bundleGeneration(bundle), null, "a missing bundle has no generation");
    writeFileSync(bundle, "export const promptTask = () => {};\n", "utf8");
    const expected = createHash("sha256").update("export const promptTask = () => {};\n").digest("hex").slice(0, 16);
    assert.equal(bundleGeneration(bundle), expected);
    // Rebuilding changes the generation, which is what makes it a build id.
    writeFileSync(bundle, "export const promptTask = () => {};//v2\n", "utf8");
    assert.notEqual(bundleGeneration(bundle), expected);
    assert.equal(
      bundleGeneration(bundle, { readBytes: () => { throw new Error("EACCES"); } }),
      null,
      "an unreadable bundle is unknown, not fatal",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plan starts the Backend entry with the pinned generation and token", () => {
  const plan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t".repeat(40), generation: "gen-a" });
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.args, [join(REPO_ROOT, BACKEND_ENTRY_RELATIVE_PATH)]);
  assert.equal(plan.cwd, REPO_ROOT);
  assert.equal(plan.generation, "gen-a");
  assert.equal(plan.env.LEAFCODE_PI_BACKEND_TOKEN, "t".repeat(40));
  assert.equal(plan.env.LEAFCODE_PI_BACKEND_GENERATION, "gen-a");
  assert.equal(plan.env.LEAFCODE_PI_BACKEND_RUNTIME_BUNDLE, join(REPO_ROOT, RUNTIME_BUNDLE_RELATIVE_PATH));
  // Native MCP is on by default for the Backend child, with an env opt-out for rollback.
  assert.equal(plan.env.LEAFCODE_PI_MCP_NATIVE, "1");
  assert.equal(backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t".repeat(40), env: { LEAFCODE_PI_MCP_NATIVE: "0" } }).env.LEAFCODE_PI_MCP_NATIVE, "0");
  // The Web process still owns the SDK, so the Host must not attach the runtime by default.
  assert.equal(plan.runtime, "detached");
  assert.equal(plan.env.LEAFCODE_PI_BACKEND_RUNTIME, "");
});

test("attaching the runtime is explicit, and needs an identifiable generation to pin", () => {
  const plan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", attachRuntime: true, generation: "gen-a" });
  assert.equal(plan.runtime, "attach");
  assert.equal(plan.env.LEAFCODE_PI_BACKEND_RUNTIME, "attach");
  const unbuilt = backendLaunchPlan({
    repoRoot: REPO_ROOT,
    token: "t",
    attachRuntime: true,
    bundlePath: join(tmpdir(), "leafcode-no-such-bundle.mjs"),
  });
  assert.equal(unbuilt.generation, null);
  assert.equal("LEAFCODE_PI_BACKEND_GENERATION" in unbuilt.env, false, "nothing to pin without a bundle");
  assert.equal(unbuilt.env.LEAFCODE_PI_BACKEND_RUNTIME, "attach", "a missing bundle is the Backend's 503, not a refusal to start");
});

test("an operator can ask for the runtime through the environment", () => {
  for (const value of ["1", "true", "yes", "attach", " ATTACH "]) {
    const plan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", env: { LEAFCODE_PI_BACKEND_RUNTIME: value }, generation: "gen-a" });
    assert.equal(plan.runtime, "attach", value);
  }
  for (const value of ["", "0", "no", "maybe"]) {
    const plan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", env: { LEAFCODE_PI_BACKEND_RUNTIME: value }, generation: "gen-a" });
    assert.equal(plan.runtime, "detached", value);
  }
});

test("the port is passed through when configured", () => {
  const plan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", env: { LEAFCODE_PI_BACKEND_PORT: " 18888 " }, generation: "gen-a" });
  assert.equal(plan.env.LEAFCODE_PI_BACKEND_PORT, "18888");
  const defaultPlan = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", generation: "gen-a" });
  assert.equal("LEAFCODE_PI_BACKEND_PORT" in defaultPlan.env, false, "the Backend's own default applies");
});

test("the WebUI gets how to reach the Backend and which generation to expect", () => {
  const plan = backendLaunchPlan({
    repoRoot: REPO_ROOT,
    token: "t".repeat(40),
    env: { LEAFCODE_PI_BACKEND_PORT: "18888" },
    generation: "gen-a",
  });
  assert.deepEqual(backendClientEnv(plan), {
    LEAFCODE_PI_BACKEND_TOKEN: "t".repeat(40),
    LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:18888",
    LEAFCODE_PI_BACKEND_GENERATION: "gen-a",
  });
  // Without a pinned generation the WebUI has no expectation to compare; the URL still resolves
  // to the Backend's default port so the Host-side restart guard can verify the runtime.
  const unbuilt = backendLaunchPlan({ repoRoot: REPO_ROOT, token: "t", generation: null });
  assert.deepEqual(backendClientEnv(unbuilt), {
    LEAFCODE_PI_BACKEND_TOKEN: "t",
    LEAFCODE_PI_BACKEND_URL: "http://127.0.0.1:18776",
  });
});

test("a plan without a repo root or token is refused", () => {
  assert.throws(() => backendLaunchPlan({ token: "t" }), /repoRoot is required/);
  assert.throws(() => backendLaunchPlan({ repoRoot: REPO_ROOT }), /token is required/);
  assert.throws(() => backendClientEnv(null), /plan is required/);
});
