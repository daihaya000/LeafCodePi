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

test("Web and Backend pin one Pi SDK/AI generation in manifests and lockfiles", () => {
  const version = readJson(join(root, "backend", "package.json")).dependencies[sdkPackage];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(assertPiDependencyVersions(join(root, "web"), join(root, "backend")), version);
  for (const project of ["web", "backend"]) {
    const manifest = readJson(join(root, project, "package.json"));
    assert.equal(manifest.dependencies[sdkPackage], version, `${project}: SDK must be pinned`);
    assert.equal(manifest.dependencies[aiPackage], version, `${project}: direct AI must match the SDK`);
    const lock = readJson(join(root, project, "package-lock.json"));
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
    for (const name of [sdkPackage, aiPackage]) {
      const packages = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
      assert.ok(packages.length > 0, `${project}: ${name} must be locked`);
      for (const [path, entry] of packages) {
        assert.equal(entry.version, version, `${project}/${path}: mixed Pi generation`);
      }
    }
  }
});

test("the Backend bundle externalizes both Pi packages instead of embedding a stale AI generation", () => {
  for (const name of PI_PACKAGES) assert.ok(runtimeExternals().includes(name));
});

test("Web direct AI modules provide the SDK's Anthropic federation exports", async () => {
  const aiDist = join(root, "web", "node_modules", aiPackage, "dist");
  const env = await import(pathToFileURL(join(aiDist, "env-api-keys.js")).href);
  assert.equal(env.ANTHROPIC_FEDERATION_RULE_ID_ENV, "ANTHROPIC_FEDERATION_RULE_ID");
  await import(pathToFileURL(join(aiDist, "providers", "anthropic.js")).href);
  await import(pathToFileURL(join(aiDist, "api", "anthropic-messages.js")).href);
});
