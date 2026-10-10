import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { assertPiDependencyVersions, PI_PACKAGES } from "../../shared/pi-dependencies.mjs";
import { runtimeExternals } from "../../scripts/build-backend-runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sdkPackage = "@earendil-works/pi-coding-agent";
const aiPackage = "@earendil-works/pi-ai";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("Backend alone pins one Pi SDK/AI generation in its manifest and lockfile", () => {
  const manifest = readJson(join(root, "backend", "package.json"));
  const version = manifest.dependencies[sdkPackage];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(assertPiDependencyVersions(join(root, "backend")), version);
  assert.equal(manifest.dependencies[aiPackage], version);
  const lock = readJson(join(root, "backend", "package-lock.json"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  for (const name of PI_PACKAGES) {
    const packages = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
    assert.ok(packages.length > 0, `${name} must be locked`);
    for (const [path, entry] of packages) assert.equal(entry.version, version, `${path}: mixed Pi generation`);
  }
});

test("Web manifest and every lockfile entry exclude SDK, provider and SQLite installations", () => {
  const manifest = readJson(join(root, "web", "package.json"));
  const lock = readJson(join(root, "web", "package-lock.json"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
  const forbidden = /@earendil-works\/(?:pi-|photon)|@rahularya01\/pi-cursor|(?:^|node_modules\/)(?:better-sqlite3|pi-commandcode-provider|@types\/better-sqlite3)(?:\/|$)/;
  for (const section of [manifest.dependencies, manifest.devDependencies, manifest.overrides, manifest.allowScripts]) {
    for (const name of Object.keys(section ?? {})) assert.equal(forbidden.test(name), false, name);
  }
  for (const path of Object.keys(lock.packages)) assert.equal(forbidden.test(path), false, path);
  // jiti remains a Tailwind dev-tool dependency, not a Web runtime/SDK dependency.
  assert.equal(manifest.dependencies.jiti, undefined);
});

test("the Backend bundle externalizes both Pi packages instead of embedding a stale AI generation", () => {
  for (const name of PI_PACKAGES) assert.ok(runtimeExternals().includes(name));
});

test("Backend direct AI modules provide the SDK's Anthropic federation exports", async () => {
  const aiDist = join(root, "backend", "node_modules", aiPackage, "dist");
  const env = await import(pathToFileURL(join(aiDist, "env-api-keys.js")).href);
  assert.equal(env.ANTHROPIC_FEDERATION_RULE_ID_ENV, "ANTHROPIC_FEDERATION_RULE_ID");
  await import(pathToFileURL(join(aiDist, "providers", "anthropic.js")).href);
  await import(pathToFileURL(join(aiDist, "api", "anthropic-messages.js")).href);
});
