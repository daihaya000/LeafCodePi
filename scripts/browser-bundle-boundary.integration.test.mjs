import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spaBuildEnvironment, spaSourceSnapshot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("real production Browser build refuses reachable vendor indirect eval before emitting artifacts", { timeout: 180000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "browser-vendor-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Use the production transport snapshot, with no borrowed package junctions or owner runtime.
  for (const [path, bytes] of spaSourceSnapshot(ROOT).files) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), web = join(root, "web");
  async function run(args, cwd = web) {
    const child = spawn(process.execPath, args, { cwd, env: spaBuildEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", part => { output = (output + part).slice(-16000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    const code = await new Promise((res, reject) => { child.once("error", reject); child.once("close", res); }); clearTimeout(timer);
    return { code, output };
  }
  let result = await run([npm, "ci", "--offline", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(result.code, 0, result.output);
  for (const name of ["next", "@next", "eslint-config-next"]) assert.equal(existsSync(join(web, "node_modules", name)), false);
  const args = [join(web, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.config.ts"];
  result = await run(args); assert.equal(result.code, 0, result.output);
  const output = join(web, "dist-spa"); assert.equal(existsSync(join(output, "index.html")), true);
  rmSync(output, { recursive: true });
  const vendor = join(web, "node_modules/next-themes/dist/index.mjs");
  writeFileSync(vendor, readFileSync(vendor, "utf8") + '\nReflect.get(globalThis, "eval")("globalThis.__P4_EVAL_CANARY__ = true");\n');
  // The type/first-party graph alone is insufficient: the emitted value gate must reject.
  result = await run([join(root, "scripts/production-boundary.mjs"), "--browser"], root); assert.equal(result.code, 0, result.output);
  result = await run(args); assert.notEqual(result.code, 0, "Reachable vendor eval incorrectly passed production build");
  assert.match(result.output, /(?:global|reflected) loader.*forbidden/, result.output);
  assert.equal(existsSync(join(output, "index.html")), false);
  assert.equal(existsSync(join(output, "assets")) && readdirSync(join(output, "assets")).some(name => name.endsWith(".js")), false);
  t.diagnostic(JSON.stringify({ cleanInstall: true, healthyBuild: true, typeGatePassedWithVendorCanary: true, vendorEvalRejected: true, emittedUnsafeJavaScript: false }));
});
