import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spaBuildEnvironment, spaSourceSnapshot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("real production Browser build refuses vendor reflection, Event spoofing and first-party eval before emitting artifacts", { timeout: 420000 }, async t => {
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
  assert.equal(readdirSync(join(output, "assets")).some(name => name.endsWith(".map")), false);
  const vendor = join(web, "node_modules/next-themes/dist/index.mjs"), original = readFileSync(vendor, "utf8");
  const descriptor = 'const key = ["constr", "uctor"].join(""); const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => {}), key); if (descriptor) { const invoke = descriptor.value; invoke("globalThis.__P4_DESCRIPTOR_EVAL__ = true")(); }';
  const event = 'const event = () => {}; event.type = ""; event.toString = () => "globalThis.__P4_EVENT_EVAL__ = true"; (new event.constructor(event.type, event))();';
  // A vendor-supplied map must not impersonate the audited React Event site.
  const react = readFileSync(join(web, "node_modules/react-dom/cjs/react-dom-client.production.js"), "utf8");
  const origin = react.slice(0, react.indexOf("nextBlockedOn.constructor(")).split("\n");
  const vlq = value => { let encoded = "", bits = value * 2; do { const digit = bits & 31; bits >>>= 5; encoded += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[digit | (bits ? 32 : 0)]; } while (bits); return encoded; };
  // Map every vendor line to the precise approved constructor, not an unrelated line.
  const forged = { version: 3, names: [], sources: ["../../react-dom/cjs/react-dom-client.production.js"], sourcesContent: [react], mappings: "AA" + vlq(origin.length - 1) + vlq(origin.at(-1).length) + ";AAAA;AAAA;AAAA" };
  const probes = [
    'Reflect.get(globalThis, "eval")("globalThis.__P4_EVAL_CANARY__ = true");',
    descriptor, event,
    'const key = ["constr", "uctor"].join(""); const fn = () => {}; fn[key]("globalThis.__P4_COMPUTED_EVAL__ = true")();',
    'let proto; proto = Object.getPrototypeOf(() => {}); const key = ["constr", "uctor"].join(""); proto[key]("globalThis.__P4_ASSIGNED_EVAL__ = true")();',
    event + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(forged)).toString("base64"),
  ];
  for (const source of probes) {
    rmSync(output, { recursive: true, force: true });
    writeFileSync(vendor, original + '\n' + source + '\n');
    result = await run(args); assert.notEqual(result.code, 0, "Reachable vendor eval incorrectly passed production build");
    assert.match(result.output, /loader.*forbidden|evaluation forbidden/, result.output);
    assert.equal(existsSync(join(output, "index.html")), false);
    assert.equal(existsSync(join(output, "assets")) && readdirSync(join(output, "assets")).some(name => name.endsWith(".js")), false);
  }
  writeFileSync(vendor, original);
  // The previously published first-party descriptor canary must fail before compiler output.
  const entry = join(web, "src/spa/main.tsx"); writeFileSync(entry, readFileSync(entry, "utf8") + '\n{ ' + descriptor + ' }\n');
  result = await run([join(root, "scripts/build-spa-worker.mjs"), join(root, "refused-stage")], root);
  assert.notEqual(result.code, 0, "First-party descriptor eval passed paired build worker");
  assert.match(result.output, /reflected loader.*forbidden/, result.output);
  assert.equal(existsSync(join(root, "refused-stage/spa/index.html")), false);
  t.diagnostic(JSON.stringify({ cleanInstall: true, healthyBuild: true, privateMapsNotPublished: true, vendorRefusals: probes.length, firstPartyRefusedBeforeOutput: true, emittedUnsafeJavaScript: false }));
});
