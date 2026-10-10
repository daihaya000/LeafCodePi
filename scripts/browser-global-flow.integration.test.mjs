import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spaBuildEnvironment, spaSourceSnapshot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("real production Browser build refuses globals hidden by local arguments and returns", { timeout: 360000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "browser-global-flow-"));
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
    'const key = ["ev", "al"].join(""); function invoke(root) { root[key]("globalThis.__P4_ARGUMENT_EVAL__=true"); } invoke(globalThis);',
    'const key = ["ev", "al"].join(""); function identity(root) { return root; } const receiver = identity(globalThis); receiver[key]("globalThis.__P4_RETURN_EVAL__=true");',
    'const key = ["ev", "al"].join(""); const receiver = globalThis; const forward = value => value; const alias = forward; alias(receiver)[key]("globalThis.__P4_ALIAS_RETURN_EVAL__=true");',
    'const key = ["ev", "al"].join(""); function entry() { invoke(globalThis); } let invoke; invoke = root => root[key]("globalThis.__P4_LATE_HELPER_EVAL__=true"); entry();',
  ];
  // Supplied source maps cannot impersonate React's pinned global-transport sites.
  const react = readFileSync(join(web, "node_modules/react-dom/cjs/react-dom-client.production.js"), "utf8");
  const origin = react.slice(0, react.indexOf("this.target = nativeEventTarget;")).split("\n");
  const vlq = value => { let encoded = "", bits = value * 2; do { const digit = bits & 31; bits >>>= 5; encoded += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[digit | (bits ? 32 : 0)]; } while (bits); return encoded; };
  const forged = { version: 3, names: [], sources: ["../../react-dom/cjs/react-dom-client.production.js"], sourcesContent: [react], mappings: "AA" + vlq(origin.length - 1) + vlq(origin.at(-1).length) + ";AAAA;AAAA;AAAA" };
  probes.push(probes[0] + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(forged)).toString("base64"));
  for (const source of probes) {
    rmSync(output, { recursive: true, force: true });
    writeFileSync(vendor, original + "\n" + source + "\n");
    result = await run(args); assert.notEqual(result.code, 0, "Interprocedural vendor eval passed production build");
    assert.match(result.output, /loader.*forbidden|evaluation forbidden/, result.output);
    assert.equal(existsSync(join(output, "index.html")), false);
    assert.equal(existsSync(join(output, "assets")) && readdirSync(join(output, "assets")).some(name => name.endsWith(".js")), false);
  }
  t.diagnostic(JSON.stringify({ cleanInstall: true, healthyBuild: true, vendorRefusals: probes.length, emittedUnsafeJavaScript: false }));
});
