import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMirrorRoot } from "./build-workspace.mjs";
import { createStaticHandler } from "../gateway/src/static.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const norm = path => path.replaceAll("\\", "/");
const skipped = new Set(["node_modules", "dist", "dist-spa", "coverage", "next-env.d.ts", "tsconfig.tsbuildinfo"]);
function regular(path, directory = false) { const stat = lstatSync(path); if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error("SPA mirror requires regular files/directories"); return stat; }
function safeAncestors(path) { for (let here = resolve(path); ; here = dirname(here)) { if (existsSync(here) && lstatSync(here).isSymbolicLink()) throw new Error("Linked SPA mirror ancestor"); if (dirname(here) === here) break; } }
function overlaps(a, b) { const lower = path => process.platform === "win32" ? path.toLowerCase() : path; a = lower(resolve(a)); b = lower(resolve(b)); return a === b || a.startsWith(b + sep) || b.startsWith(a + sep); }
function location(root, checkout = ROOT) {
  if (!isAbsolute(root)) throw new Error("SPA mirror path must be absolute");
  const path = resolve(root); safeAncestors(path); safeAncestors(checkout);
  if (overlaps(path, realpathSync(checkout))) throw new Error("SPA mirror must be outside the checkout");
  for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) if (process.env[name] && overlaps(path, process.env[name])) throw new Error("SPA mirror must be outside OneDrive");
  return path;
}
export function resolveSpaMirrorRoot(env = process.env, sourceDir = join(ROOT, "web")) { return join(resolveMirrorRoot(env, sourceDir), ".spa"); }

/** Only Web/shared/transport build inputs, never Backend/Host/extensions or dotenv/user data. */
export function spaSourceSnapshot(checkout = ROOT) {
  const files = new Map();
  function walk(path, prefix) {
    regular(path, true);
    for (const name of readdirSync(path).sort()) {
      if (name.startsWith(".") || skipped.has(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
      const from = join(path, name), rel = prefix + "/" + name, info = lstatSync(from);
      if (info.isSymbolicLink()) throw new Error("Linked SPA source");
      if (info.isDirectory()) walk(from, rel);
      else { regular(from); files.set(rel, readFileSync(from)); }
    }
  }
  for (const folder of ["web", "shared", "gateway/src", "scripts"]) walk(join(checkout, folder), folder);
  for (const file of ["gateway/package.json", "gateway/package-lock.json", "docs/plans/next-thin-phase0.json"]) { regular(join(checkout, file)); files.set(file, readFileSync(join(checkout, file))); }
  return { files, digest: hash(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, content]) => [path, hash(content)]))) };
}
function state(root) {
  const file = join(root, "state.json"); if (!existsSync(file)) return { version: 1, current: null, previous: null };
  regular(file); const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || ![value.current, value.previous].every(id => id === null || typeof id === "string" && idPattern.test(id)) || value.current && value.current === value.previous) throw new Error("Invalid SPA generation pointer");
  return { version: 1, current: value.current, previous: value.previous };
}
function atomicState(root, value) {
  const temporary = join(root, `.pointer-${randomUUID()}`);
  try { writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temporary, join(root, "state.json")); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
async function locked(root, action) {
  mkdirSync(root, { recursive: true }); regular(root, true);
  const lock = join(root, "build.lock"), fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  try { return await action(); } finally { closeSync(fd); unlinkSync(lock); }
}
function artifactFiles(root) {
  const files = {};
  function walk(folder) {
    regular(folder, true);
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name), info = lstatSync(path), rel = norm(relative(root, path));
      if (info.isSymbolicLink()) throw new Error("Linked SPA generation artifact");
      if (info.isDirectory()) walk(path);
      else { regular(path); if (rel !== "generation.json") files[rel] = hash(readFileSync(path)); }
    }
  }
  walk(root); return files;
}
async function validatePair(directory, { allowLegacy = false } = {}) {
  await createStaticHandler(join(directory, "spa"));
  for (const file of ["gateway/dist/gateway/src/index.mjs", "gateway/dist/manifest.json", "gateway/package.json", "gateway/package-lock.json", "gateway/node_modules/undici/package.json"]) regular(join(directory, file));
  const manifest = JSON.parse(readFileSync(join(directory, "gateway/dist/manifest.json")));
  const validCounts = Array.isArray(manifest.routes) && ((manifest.routes.length === 166 && manifest.operations === 267) || (allowLegacy && manifest.routes.length === 165 && manifest.operations === 265));
  if (!validCounts || !Array.isArray(manifest.sources) || !manifest.sources.every(path => typeof path === "string" && /^(gateway\/src\/|shared\/|web\/src\/app\/api\/|web\/src\/lib\/)/.test(path))) throw new Error("Invalid gateway generation manifest");
  const pkg = JSON.parse(readFileSync(join(directory, "gateway/package.json"))), lock = JSON.parse(readFileSync(join(directory, "gateway/package-lock.json"))), installed = JSON.parse(readFileSync(join(directory, "gateway/node_modules/undici/package.json")));
  if (Object.keys(pkg.dependencies ?? {}).join() !== "undici" || installed.version !== pkg.dependencies.undici || lock.packages?.["node_modules/undici"]?.version !== installed.version || Object.keys(lock.packages).some(path => path && path !== "node_modules/undici")) throw new Error("Unexpected gateway runtime dependencies");
  for (const name of readdirSync(join(directory, "gateway/node_modules"))) if (name !== "undici" && name !== ".package-lock.json") throw new Error("Extra gateway runtime dependency");
}
export async function readSpaGeneration(root, id, { checkout = ROOT } = {}) {
  root = location(root, checkout); if (!idPattern.test(id ?? "")) throw new Error("Invalid SPA generation ID");
  const directory = join(root, "generations", id); safeAncestors(directory); regular(directory, true); regular(join(directory, "generation.json"));
  const metadata = JSON.parse(readFileSync(join(directory, "generation.json"), "utf8"));
  if (metadata.version !== 1 || metadata.id !== id || !/^[a-f0-9]{64}$/.test(metadata.sourceDigest ?? "") || !metadata.files || Object.getPrototypeOf(metadata.files) !== Object.prototype) throw new Error("Invalid SPA generation metadata");
  const actual = artifactFiles(directory);
  if (JSON.stringify(actual) !== JSON.stringify(metadata.files)) throw new Error("SPA generation integrity mismatch");
  await validatePair(directory, { allowLegacy: true });
  return { ...metadata, directory, staticRoot: join(directory, "spa"), cwd: join(directory, "gateway"), entry: join(directory, "gateway/dist/gateway/src/index.mjs") };
}
export async function selectSpaGeneration(root, { checkout = ROOT } = {}) {
  root = location(root, checkout); const pointer = state(root); const failures = [];
  for (const id of [pointer.current, pointer.previous].filter(Boolean)) {
    try { return { ...await readSpaGeneration(root, id, { checkout }), fallback: id !== pointer.current, pointerCurrent: pointer.current }; } catch (error) { failures.push(error.message); }
  }
  throw new Error("SPA production generation unavailable" + (failures.length ? `: ${failures.join("; ")}` : ""));
}
export async function rollbackSpaGeneration(root, { expectedCurrent, checkout = ROOT } = {}) {
  root = location(root, checkout);
  return locked(root, async () => {
    const pointer = state(root);
    if (pointer.current !== expectedCurrent || !pointer.previous) throw new Error("SPA rollback pointer changed or previous generation absent");
    const previous = await readSpaGeneration(root, pointer.previous, { checkout });
    atomicState(root, { version: 1, current: previous.id, previous: null });
    return previous;
  });
}
export function spaBuildEnvironment(env = process.env) {
  const safe = Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|Path|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS)$/.test(key)));
  return { ...safe, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
}
async function run(args, cwd, env, log = () => {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("SPA build command deadline")); }, 300000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => log(chunk.toString()));
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`SPA build command exited ${code}`)); });
  });
}
async function compile({ workspace, stage, offline, log }) {
  const env = spaBuildEnvironment(), npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...(offline ? ["--offline"] : [])];
  const stamp = join(workspace, "web/node_modules/.spa-build-deps"), dependencyHash = hash(readFileSync(join(workspace, "web/package.json"))) + hash(readFileSync(join(workspace, "web/package-lock.json")));
  const ready = existsSync(stamp) && readFileSync(stamp, "utf8") === dependencyHash && ["vite", "typescript", "react", "@tailwindcss/postcss"].every(name => existsSync(join(workspace, "web/node_modules", name, "package.json")));
  if (!ready) { await run([npm, ...args, "--include=dev"], join(workspace, "web"), env, log); writeFileSync(stamp, dependencyHash); }
  await run([join(workspace, "scripts/build-spa-worker.mjs"), stage], workspace, env, log);
  await run([npm, ...args, "--omit=dev"], join(stage, "gateway"), env, log);
  // Re-check the actual locked install before sealing; the workspace package is not the artifact.
  await run([join(workspace, "scripts/gateway-runtime-boundary.mjs"), join(stage, "gateway/node_modules/undici")], workspace, env, log);
}

/** Publish only a sealed complete pair. Old generations are retained for running processes. */
export async function buildSpaGeneration({ checkout = ROOT, mirrorRoot = resolveSpaMirrorRoot(process.env, join(checkout, "web")), compileBuild = compile, offline = false, log = () => {}, writePointer = atomicState } = {}) {
  mirrorRoot = location(mirrorRoot, checkout);
  return locked(mirrorRoot, async () => {
    const pointer = state(mirrorRoot), snapshot = spaSourceSnapshot(checkout), workspace = join(mirrorRoot, "workspace"), id = randomUUID(), stage = join(mirrorRoot, `.stage-${id}`), destination = join(mirrorRoot, "generations", id);
    safeAncestors(workspace); mkdirSync(workspace, { recursive: true });
    safeAncestors(join(workspace, "web/node_modules"));
    // Keep only dependency installations between snapshots; no active generation lives here.
    for (const folder of ["web", "shared", "gateway", "scripts", "docs"]) {
      const path = join(workspace, folder); if (!existsSync(path)) continue; regular(path, true);
      for (const name of readdirSync(path)) if (!(folder === "web" && name === "node_modules")) rmSync(join(path, name), { recursive: true, force: true });
    }
    for (const [path, bytes] of snapshot.files) { const target = join(workspace, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
    mkdirSync(stage); mkdirSync(join(stage, "gateway"));
    for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(workspace, "gateway", name), join(stage, "gateway", name));
    try {
      await compileBuild({ workspace, stage, offline, log });
      if (spaSourceSnapshot(checkout).digest !== snapshot.digest) throw new Error("SPA sources changed during build");
      await validatePair(stage);
      const metadata = { version: 1, id, sourceDigest: snapshot.digest, builtAt: Date.now(), files: artifactFiles(stage) };
      writeFileSync(join(stage, "generation.json"), JSON.stringify(metadata) + "\n", { flag: "wx", mode: 0o600 });
      safeAncestors(join(mirrorRoot, "generations")); mkdirSync(join(mirrorRoot, "generations"), { recursive: true }); renameSync(stage, destination);
      const result = await readSpaGeneration(mirrorRoot, id, { checkout });
      let previous = null;
      for (const candidate of [pointer.current, pointer.previous].filter(Boolean)) try { await readSpaGeneration(mirrorRoot, candidate, { checkout }); previous = candidate; break; } catch { /* invalid generations cannot become recovery targets */ }
      writePointer(mirrorRoot, { version: 1, current: id, previous });
      return result;
    } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ type: "spa_generation_built", id: (await buildSpaGeneration({ offline: process.argv.includes("--offline"), log: text => process.stderr.write(text) })).id })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
