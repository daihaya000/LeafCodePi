import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireRuntimeOwner } from "../backend/core/runtime-owner-lock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(join(ROOT, "backend/package.json"))("esbuild");

test("real Next register code is cold-concurrency safe and cannot claim another process's Backend slot", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "leafcode-next-register-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const release = acquireRuntimeOwner(fixture);
  t.after(release);
  const before = new Map(readdirSync(fixture).map((name) => [name, readFileSync(join(fixture, name))]));
  const bundle = join(fixture, "register.mjs"), guard = join(fixture, "guard.mjs");
  const built = await build({ entryPoints: [join(ROOT, "web/src/instrumentation.ts")], outfile: bundle, bundle: true,
    platform: "node", format: "esm", alias: { "@": join(ROOT, "web/src") }, metafile: true, logLevel: "silent" });
  assert.equal(Object.keys(built.metafile.inputs).length, 2);
  for (const path of Object.keys(built.metafile.inputs)) assert.equal(/backend|runtime-startup|harness/.test(path), false, path);
  await build({ entryPoints: [join(ROOT, "backend/runtime-src/lib/pi/runtime-ownership.ts")], outfile: guard,
    bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const worker = join(fixture, "worker.mjs");
  writeFileSync(worker, `
    import assert from 'node:assert/strict';
    import {ServerResponse} from 'node:http';
    import {register} from './register.mjs';
    import {assertLocalRuntimeAllowed,localRuntimeBlocked,isBackendRuntimeHost} from './guard.mjs';
    const original=ServerResponse.prototype.setHeader;
    await Promise.all([register(),register(),register()]);
    assert.equal(process.env.LEAFCODE_PI_PROCESS_ROLE,'next');
    assert.equal(localRuntimeBlocked(),true);
    assert.equal(isBackendRuntimeHost(),false);
    assert.throws(()=>assertLocalRuntimeAllowed(),/Backend/);
    const patched=ServerResponse.prototype.setHeader;
    assert.notEqual(patched,original);
    await Promise.all([register(),register()]);
    assert.equal(ServerResponse.prototype.setHeader,patched);
    assert.equal(globalThis.__leafcodeRuntimeStartup,undefined);
    assert.equal(globalThis.__leafcodeRuntimeOwnerRelease,undefined);
    assert.equal(globalThis.__leafcodePiHarness,undefined);
    console.log(JSON.stringify({role:process.env.LEAFCODE_PI_PROCESS_ROLE,blocked:true,registrations:5}));
  `, "utf8");
  for (const mode of ["development", "production", "test"]) {
    const child = spawnSync(process.execPath, [worker], { cwd: fixture, encoding: "utf8", timeout: 5_000,
      env: { ...process.env, NEXT_RUNTIME: "nodejs", NODE_ENV: mode, LEAFCODE_PI_PROCESS_ROLE: "backend",
        LEAFCODE_PI_BACKEND_RUNTIME: "attach", LEAFCODE_PI_DATA_DIR: fixture, NODE_OPTIONS: "" } });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { role: "next", blocked: true, registrations: 5 });
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(fixture, name)), bytes);
  }
  assert.deepEqual(readdirSync(fixture).sort(), [...before.keys(), "register.mjs", "guard.mjs", "worker.mjs"].sort());
});
