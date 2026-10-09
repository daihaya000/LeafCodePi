import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export const STREAM_TEST_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const PRODUCTION_STREAM_ROUTES = ["tasks/[id]/events", "bots/[id]/events", "bots/events", "bots/rooms/[id]/events", "tasks/[id]/media", "tasks/[id]/image", "tasks/[id]/message-image", "bots/rooms/[id]/files/[file]", "bots/rooms/[id]/images/[file]", "browse/icon", "projects/[id]/icon", "link-preview/image", "profile", "tts/synthesize", "providers/[id]/login/events"];
/** Production compile of unchanged REAL routes/imports, not a relay or adapter substitute. */
export async function buildStreamProductionApp(app, env, children) {
  const root = STREAM_TEST_ROOT, require = createRequire(join(root, "web/package.json")), ts = require("typescript");
  const aliases = { "@": "web/src", "@shared": "shared", "@backend-runtime": "backend/runtime-src", "@backend-core": "backend/core" }, copied = new Set();
  function copy(source) {
    if (copied.has(source)) return;
    assert.ok(source.startsWith(root + "\\") || source.startsWith(root + "/")); copied.add(source);
    const destination = join(app, "source", relative(root, source)); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    for (const { fileName: name } of ts.preProcessFile(readFileSync(source, "utf8"), true, true).importedFiles) {
      let path;
      if (name.startsWith(".")) path = resolve(dirname(source), name);
      else { const key = Object.keys(aliases).find(k => name.startsWith(k + "/")); if (key) path = join(root, aliases[key], name.slice(key.length + 1)); }
      if (!path) continue;
      const found = [path, path + ".ts", path + ".tsx", path + ".mjs", path + ".js", join(path, "index.ts")].find(p => existsSync(p)); assert.ok(found, "missing source " + path); copy(found);
    }
  }
  for (const route of PRODUCTION_STREAM_ROUTES) {
    const source = join(root, "web/src/app/api", route, "route.ts"); copy(source);
    const dest = join(app, "app/api", route, "route.ts"); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(source, dest);
  }
  assert.ok(![...copied].some(p => /[\\/]pi[\\/]harness\.ts$/.test(p)), "Next must not import the SDK harness");
  writeFileSync(join(app, "app/layout.tsx"), 'export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}');
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "leafcode-stream-production-fixture", version: "1.0.0", private: true }));
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "esnext"], module: "esnext", moduleResolution: "bundler", jsx: "preserve", esModuleInterop: true, skipLibCheck: true, baseUrl: ".", paths: Object.fromEntries(Object.entries(aliases).map(([k,v]) => [k + "/*", ["source/" + v + "/*"]])) } }));
  writeFileSync(join(app, "next.config.mjs"), "export default {experimental:{cpus:2},typescript:{ignoreBuildErrors:true}};");
  // New temporary dependency reference only. Never modify installed packages.
  symlinkSync(join(root, "web/node_modules"), join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--webpack", app], { env: { ...env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LEAFCODE_PI_PROCESS_ROLE: "next" }, cwd: app, stdio: ["ignore", "pipe", "pipe"] }); children.push(c);
    let output = ""; for (const stream of [c.stdout,c.stderr]) stream.on("data", b => output = (output + b).slice(-20000));
    c.once("error", reject); c.once("exit", code => code === 0 ? resolve() : reject(Error(output)));
  });
  return { routes: PRODUCTION_STREAM_ROUTES.length, modules: copied.size };
}
