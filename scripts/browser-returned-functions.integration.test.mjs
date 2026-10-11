import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spaBuildEnvironment, spaSourceSnapshot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("real production Browser build refuses returned local function invocations", { timeout: 420000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "browser-returned-functions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, bytes] of spaSourceSnapshot(ROOT).files) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  const web = join(root, "web"), npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  async function run(args) {
    const child = spawn(process.execPath, args, { cwd: web, env: spaBuildEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const vendor = join(web, "node_modules/next-themes/dist/index.mjs"), original = readFileSync(vendor, "utf8");
  const key = 'const key=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); ';
  const probes = [
    'function make(){return fn=>fn[key]("globalThis.__P4_RETURNED_INVOCATION__=true")();}make()(()=>{});',
    'function make(fn){return ()=>fn;}make(()=>{})()[key]("globalThis.__P4_RETURNED_CLOSURE__=true")();',
    'function make(){return function(){this[key]("globalThis.__P4_RETURNED_RECEIVER__=true")();};}make().call(()=>{});',
    'function make(){function run(prefix,fn){fn[key]("globalThis.__P4_RETURNED_BOUND__=true")();}return run.bind(null,0);}make()(()=>{});',
  ];
  for (const probe of probes) {
    rmSync(output, { recursive: true, force: true });
    writeFileSync(vendor, original + "\n" + key + probe + "\n");
    result = await run(args); assert.notEqual(result.code, 0, "Returned function capability passed production build");
    assert.match(result.output, /loader.*forbidden|evaluation forbidden/, result.output);
    assert.equal(existsSync(join(output, "index.html")), false);
    assert.equal(existsSync(join(output, "assets")) && readdirSync(join(output, "assets")).some(name => name.endsWith(".js")), false);
  }
  t.diagnostic(JSON.stringify({ cleanInstall: true, healthyBuild: true, vendorRefusals: probes.length, emittedUnsafeJavaScript: false }));
});
