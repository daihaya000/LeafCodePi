import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spaBuildEnvironment, spaSourceSnapshot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("real production Browser build refuses plain-object opaque constructor chains", { timeout: 900000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "browser-object-constructor-"));
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
  const probes = [
    { label: "direct", key: 'const key=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); ', body: 'const data={};const first=data[key];first[key]("globalThis.__P4_OBJECT_DIRECT__=true")();' },
    { label: "template", key: 'const key=`constr${"uctor"}`; ', body: 'const data={};const first=data[key];first[key]("globalThis.__P4_OBJECT_TEMPLATE__=true")();' },
    { label: "concat", key: 'const key="constr".concat("uctor"); ', body: 'const data={};const first=data[key];first[key]("globalThis.__P4_OBJECT_CONCAT__=true")();' },
    { label: "split-join", key: 'const key="constr,uctor".split(",").join(""); ', body: 'const data={};const first=data[key];first[key]("globalThis.__P4_OBJECT_SPLITJOIN__=true")();' },
    { label: "returned-call", key: 'function f(a,b){return a+b;}const key=f("constr","uctor"); ', body: 'const data={};const first=data[key];first[key]("globalThis.__P4_OBJECT_RETURNEDCALL__=true")();' },
    { label: "fromEntries", key: 'const key=Object.fromEntries([["k","constructor"]]).k; ', body: 'const data={};const first=data[key];first[key]("globalThis.__P4_OBJECT_FROMENTRIES__=true")();' },
  ];
  for (const { label, key, body } of probes) {
    rmSync(output, { recursive: true, force: true });
    writeFileSync(vendor, original + "\n" + key + body + "\n");
    result = await run(args); assert.notEqual(result.code, 0, "Opaque object constructor chain passed production build: " + label);
    assert.match(result.output, /loader.*forbidden|evaluation forbidden/, label + ": " + result.output);
    assert.equal(existsSync(join(output, "index.html")), false, label);
    assert.equal(existsSync(join(output, "assets")) && readdirSync(join(output, "assets")).some(name => name.endsWith(".js")), false, label);
    t.diagnostic(JSON.stringify({ probe: label, buildCode: result.code, refusal: (result.output.match(/loader[^\n]*forbidden[^\n]*|evaluation forbidden[^\n]*/) ?? [])[0] }));
  }
  writeFileSync(vendor, original);
  assert.equal(readFileSync(vendor, "utf8"), original);
  t.diagnostic(JSON.stringify({ cleanInstall: true, healthyBuild: true, vendorRefusals: probes.length, emittedUnsafeJavaScript: false }));
});
