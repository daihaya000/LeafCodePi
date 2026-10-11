import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSpaGeneration, readSpaBuildMetadata, readSpaGeneration, resolveSpaMirrorRoot, rollbackSpaGeneration, selectSpaGeneration, spaBuildEnvironment, spaSourceSnapshot } from "./spa-build-generation.mjs";
import { ensureSpaGeneration, startSpaWithFallback } from "../host/src/spa-build.js";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "spa-generation-test-")), checkout = join(base, "checkout"), mirrorRoot = join(base, "mirror/.spa");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const dir of ["web", "shared", "gateway/src", "scripts", "docs/plans"]) mkdirSync(join(checkout, dir), { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(checkout, "gateway", name), readFileSync(join(ROOT, "gateway", name)));
  writeFileSync(join(checkout, "web/package.json"), "{}"); writeFileSync(join(checkout, "web/source.ts"), "export const fixture = 'first';");
  writeFileSync(join(checkout, "docs/plans/next-thin-phase0.json"), "{}");
  return { base, checkout, mirrorRoot };
}
async function fakeCompile({ stage }, label = "first") {
  for (const dir of ["spa/assets", "gateway/dist/gateway/src", "gateway/node_modules/undici"]) mkdirSync(join(stage, dir), { recursive: true });
  writeFileSync(join(stage, "spa/index.html"), `<html><script type="module" src="/assets/index-Abc123_-.js"></script>${label} 日本語 😀</html>`);
  writeFileSync(join(stage, "spa/assets/index-Abc123_-.js"), `export const fixture = ${JSON.stringify(label)};`);
  writeFileSync(join(stage, "gateway/dist/gateway/src/index.mjs"), `export const fixture = ${JSON.stringify(label)};`);
  writeFileSync(join(stage, "gateway/dist/manifest.json"), JSON.stringify({ routes: Array.from({ length: 166 }, () => ({ source: "gateway/src/index.mjs" })), operations: 267, sources: ["gateway/src/index.mjs"] }));
  writeFileSync(join(stage, "gateway/node_modules/undici/package.json"), '{"version":"8.10.2"}');
}
const pointer = root => JSON.parse(readFileSync(join(root, "state.json")));
const build = (context, compileBuild = fakeCompile, extra = {}) => buildSpaGeneration({ ...context, compileBuild, ...extra });

test("external root derives from the established mirror; source and child environment exclude secrets/owners/output", t => {
  const f = fixture(t); assert.equal(resolveSpaMirrorRoot({ LEAFCODE_PI_BUILD_DIR: join(f.base, "build") }), join(f.base, "build/.spa"));
  writeFileSync(join(f.checkout, "web/.env.production"), "PRIVATE=dummy"); mkdirSync(join(f.checkout, "web/node_modules")); writeFileSync(join(f.checkout, "web/node_modules/private.txt"), "dummy");
  mkdirSync(join(f.checkout, "backend")); writeFileSync(join(f.checkout, "backend/private.txt"), "dummy");
  writeFileSync(join(f.checkout, "shared/example.test.ts"), "dummy");
  const snapshot = spaSourceSnapshot(f.checkout); assert.ok(![...snapshot.files.keys()].some(path => /\.env|node_modules|backend\/|\.test\./.test(path)));
  const env = spaBuildEnvironment({ PATH: "safe-path", NODE_OPTIONS: "--import private", VITE_SECRET: "dummy", OPENAI_API_KEY: "dummy", LEAFCODE_PI_BACKEND_TOKEN: "dummy", NODE_ENV: "dev" });
  assert.deepEqual(env, { PATH: "safe-path", NODE_ENV: "production" });
  const metadata = { commit: "a".repeat(40), committedAt: "2026-10-09T00:00:00+00:00" };
  assert.deepEqual(spaBuildEnvironment({ PATH: "safe-path", NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT: "untrusted" }, metadata), {
    PATH: "safe-path", NODE_ENV: "production", NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT: metadata.commit,
    NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE: metadata.committedAt,
  });
  assert.deepEqual(spaBuildEnvironment({}, { commit: "invalid", committedAt: "invalid" }), {
    NODE_ENV: "production", NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT: "", NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT_DATE: "",
  });
  const calls = [];
  assert.deepEqual(readSpaBuildMetadata({ cwd: f.checkout, exec: (...args) => { calls.push(args); return `${metadata.commit}\n${metadata.committedAt}\n`; } }), metadata);
  assert.equal(calls[0][0], "git"); assert.deepEqual(calls[0][1], ["log", "-1", "--format=%H%n%cI"]); assert.equal(calls[0][2].cwd, f.checkout);
  assert.deepEqual(readSpaBuildMetadata({ cwd: f.checkout, exec: () => { throw Error("git unavailable"); } }), { commit: "", committedAt: "" });
});
test("sealed pre-OpenDesign generations remain recoverable, but new builds must include the new route", async t => {
  const f = fixture(t), first = await build(f);
  const manifestFile = join(first.directory, "gateway/dist/manifest.json");
  const legacyManifest = { routes: Array.from({ length: 165 }, () => ({ source: "gateway/src/index.mjs" })), operations: 265, sources: ["gateway/src/index.mjs"] };
  writeFileSync(manifestFile, JSON.stringify(legacyManifest));
  const metadataFile = join(first.directory, "generation.json"), metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  metadata.files["gateway/dist/manifest.json"] = createHash("sha256").update(readFileSync(manifestFile)).digest("hex");
  writeFileSync(metadataFile, JSON.stringify(metadata));
  assert.equal((await readSpaGeneration(f.mirrorRoot, first.id, f)).id, first.id);
  const fallback = await ensureSpaGeneration({ ...f, force: true, build: async () => { throw new Error("new build failed"); } });
  assert.equal(fallback.id, first.id); assert.equal(fallback.fallback, true);
  await assert.rejects(build(f, async args => { await fakeCompile(args); writeFileSync(join(args.stage, "gateway/dist/manifest.json"), JSON.stringify(legacyManifest)); }), /Invalid gateway generation manifest/);
  assert.equal(pointer(f.mirrorRoot).current, first.id);
});
test("first complete pair publishes atomically; later pair retains a verified previous generation", async t => {
  const f = fixture(t), first = await build(f), second = await build(f, args => fakeCompile(args, "second"));
  assert.deepEqual(pointer(f.mirrorRoot), { version: 1, current: second.id, previous: first.id });
  assert.equal((await selectSpaGeneration(f.mirrorRoot, f)).id, second.id); assert.equal((await readSpaGeneration(f.mirrorRoot, first.id, f)).id, first.id);
  assert.equal(readFileSync(join(first.staticRoot, "index.html"), "utf8").includes("first"), true);
  assert.equal(existsSync(join(f.mirrorRoot, "build.lock")), false); assert.equal(readdirSync(f.mirrorRoot).some(name => name.startsWith(".stage-")), false);
});
test("compile/typecheck/install/entry validation failures never publish partial output or alter current bytes", async t => {
  const f = fixture(t), first = await build(f), before = readFileSync(join(f.mirrorRoot, "state.json"), "utf8"), html = readFileSync(join(first.staticRoot, "index.html"), "utf8");
  for (const compileBuild of [async () => { throw Error("typecheck failed"); }, async args => { await fakeCompile(args); throw Error("install failed"); }, async args => { await fakeCompile(args); writeFileSync(join(args.stage, "spa/index.html"), "broken"); }]) {
    await assert.rejects(build(f, compileBuild)); assert.equal(readFileSync(join(f.mirrorRoot, "state.json"), "utf8"), before); assert.equal(readFileSync(join(first.staticRoot, "index.html"), "utf8"), html);
    assert.equal((await selectSpaGeneration(f.mirrorRoot, f)).id, first.id);
  }
});
test("a failed initial build is explicitly unavailable, not dev; Host rebuild reuses a verified pair only", async t => {
  const f = fixture(t); await assert.rejects(ensureSpaGeneration({ ...f, build: () => Promise.reject(Error("compile")) }), /production build unavailable/);
  const first = await build(f); const reused = await ensureSpaGeneration({ ...f, build: () => { throw Error("must not build an unchanged source"); } }); assert.equal(reused.id, first.id); assert.equal(reused.reused, true);
  const failed = await ensureSpaGeneration({ ...f, force: true, build: () => Promise.reject(Error("compile")) }); assert.equal(failed.id, first.id); assert.equal(failed.fallback, true);
});
test("source changes during build fail closed; exclusive writer lock leaves readers on the current generation", async t => {
  const f = fixture(t), first = await build(f); let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const next = build(f, async args => { entered(); await waiting; await fakeCompile(args); }); await ready;
  assert.equal((await selectSpaGeneration(f.mirrorRoot, f)).id, first.id); await assert.rejects(build(f), /EEXIST/);
  writeFileSync(join(f.checkout, "web/source.ts"), "changed"); release(); await assert.rejects(next, /sources changed/);
  assert.equal(pointer(f.mirrorRoot).current, first.id); assert.equal(existsSync(join(f.mirrorRoot, "build.lock")), false);
});
test("failed pointer replacement leaves an unselected sealed orphan, never a mixed pair", async t => {
  const f = fixture(t), first = await build(f), original = pointer(f.mirrorRoot);
  await assert.rejects(build(f, fakeCompile, { writePointer() { throw Error("atomic rename failed"); } }), /atomic rename/);
  assert.deepEqual(pointer(f.mirrorRoot), original); assert.equal((await selectSpaGeneration(f.mirrorRoot, f)).id, first.id); assert.equal(readdirSync(join(f.mirrorRoot, "generations")).length, 2);
});
test("tampered bytes/extra files select previous; metadata/pointer traversal and symlink generations fail closed", async t => {
  const f = fixture(t), first = await build(f), second = await build(f, args => fakeCompile(args, "second"));
  writeFileSync(join(second.staticRoot, "assets/index-Abc123_-.js"), "tampered"); await assert.rejects(readSpaGeneration(f.mirrorRoot, second.id, f), /integrity/);
  const selected = await selectSpaGeneration(f.mirrorRoot, f); assert.equal(selected.id, first.id); assert.equal(selected.fallback, true);
  writeFileSync(join(first.directory, "extra.txt"), "extra"); await assert.rejects(selectSpaGeneration(f.mirrorRoot, f), /unavailable/);
  await assert.rejects(readSpaGeneration(f.mirrorRoot, "../../outside", f), /ID/);
  writeFileSync(join(f.mirrorRoot, "state.json"), '{"version":1,"current":"../outside","previous":null}'); await assert.rejects(selectSpaGeneration(f.mirrorRoot, f), /pointer/);
});
test("runtime dependency drift and missing emitted references are rejected before publication", async t => {
  const f = fixture(t);
  for (const mutate of [stage => writeFileSync(join(stage, "gateway/node_modules/undici/package.json"), '{"version":"wrong"}'), stage => { mkdirSync(join(stage, "gateway/node_modules/next")); }, stage => writeFileSync(join(stage, "spa/index.html"), '<html><script type="module" src="/assets/missing.js"></script></html>')]) {
    await assert.rejects(build(f, async args => { await fakeCompile(args); mutate(args.stage); })); assert.equal(existsSync(join(f.mirrorRoot, "state.json")), false);
  }
});
test("rollback compare-and-swap preserves a newer pointer; Host start failure restores both old runtime and old SPA", async t => {
  const f = fixture(t), first = await build(f), second = await build(f, args => fakeCompile(args, "second"));
  await assert.rejects(rollbackSpaGeneration(f.mirrorRoot, { ...f, expectedCurrent: first.id }), /pointer changed/); assert.equal(pointer(f.mirrorRoot).current, second.id);
  const starts = [], backend = Object.freeze({ pid: 123, generation: "fixture-sdk", lease: "held", heartbeat: 456 });
  const result = await startSpaWithFallback({ ...f, start: async generation => { starts.push(generation.id); if (generation.id === second.id) throw Error("gateway start failed"); return { pid: 789 }; } });
  assert.deepEqual(starts, [second.id, first.id]); assert.equal(result.generation.id, first.id); assert.equal(result.fallback, true); assert.equal(pointer(f.mirrorRoot).current, first.id); assert.equal(backend.generation, "fixture-sdk");
  await assert.rejects(rollbackSpaGeneration(f.mirrorRoot, { ...f, expectedCurrent: first.id }), /previous/);
});
test("Host startup repairs a corrupt current pointer and reports recovery without trying corrupt bytes", async t => {
  const f = fixture(t), first = await build(f), second = await build(f);
  writeFileSync(join(second.staticRoot, "assets/index-Abc123_-.js"), "corrupt");
  const starts = [], restored = await startSpaWithFallback({ ...f, start: async generation => { starts.push(generation.id); return {}; } });
  assert.deepEqual(starts, [first.id]); assert.equal(restored.fallback, true); assert.deepEqual(pointer(f.mirrorRoot), { version: 1, current: first.id, previous: null });
});
test("mirror/source/workspace symlinks and checkout overlap are refused without modifying those targets", async t => {
  const f = fixture(t);
  await assert.rejects(build({ ...f, mirrorRoot: join(f.checkout, "web/.spa") }), /outside/);
  await assert.rejects(build({ ...f, mirrorRoot: f.base }), /outside/);
  const alias = join(f.base, "alias"); symlinkSync(f.checkout, alias, process.platform === "win32" ? "junction" : "dir"); await assert.rejects(build({ ...f, mirrorRoot: join(alias, "outside") }), /Linked/);
  mkdirSync(join(f.mirrorRoot, "workspace/web"), { recursive: true }); symlinkSync(join(f.checkout, "web"), join(f.mirrorRoot, "workspace/web/node_modules"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(build(f), /Linked/); assert.equal(readFileSync(join(f.checkout, "web/source.ts"), "utf8"), "export const fixture = 'first';");
});
