/**
 * Bundles the Pi runtime for the Backend process.
 *
 * The Backend runs the same harness the Web app does, so it is built from the same sources: the
 * Web app's `@/` alias, the shared contracts and the extracted `backend/core/` modules are all
 * resolved here. The Pi SDK and AI stay external because the Backend installs their synchronized
 * pinned copies — the bundle must never embed a second Pi generation.
 *
 * Output is a build artifact (`backend/runtime/runtime.bundle.mjs`), not source: it is ignored by
 * git and rebuilt by `npm run build:backend-runtime`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertInstalledPiVersions, assertPiDependencyVersions } from "../shared/pi-dependencies.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");
const WEB_SRC = join(ROOT, "web", "src");
const CORE = join(ROOT, "backend", "core");
const SHARED = join(ROOT, "shared");
export const BUNDLE_PATH = join(ROOT, "backend", "runtime", "runtime.bundle.mjs");
export const BUNDLE_STAMP_PATH = `${BUNDLE_PATH}.stamp`;

/** Aliases mirror the Web app's tsconfig paths plus the extracted core and shared contracts. */
export function runtimeAliases() {
  return {
    "@": WEB_SRC,
    "@backend-core": CORE,
    "@shared": SHARED,
  };
}

/**
 * Packages that must stay external. Pi AI/agent and the SDK's native MCP dependency must come from
 * the installed Backend generation; embedding MCP here would duplicate its transports/OAuth classes.
 * Node builtins are never bundled.
 */
export function runtimeExternals() {
  return ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-mcp", "node:*"];
}

function collectSourceFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(path, files);
    else if (/\.(mjs|js|ts|tsx|mts|cts|json)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/**
 * Fingerprint of the sources esbuild would pull in for the Backend runtime bundle.
 * Include all of `web/src` (not just the entry file): the entry re-exports harness and
 * store modules via `@/`, so a harness-only change must invalidate the stamp or Host
 * will keep reusing a stale `runtime.bundle.mjs` after restart.
 *
 * Also stamp lockfiles (inlined deps like undici/yaml resolve from them), and this
 * build script itself (banner / aliases / externals), so Host cannot reuse after those
 * change without a content rebuild.
 */
export function backendRuntimeSourceStamp({
  roots = [WEB_SRC, CORE, SHARED],
  webPackage = join(ROOT, "web", "package.json"),
  backendPackage = join(ROOT, "backend", "package.json"),
  webLock = join(ROOT, "web", "package-lock.json"),
  backendLock = join(ROOT, "backend", "package-lock.json"),
  buildScript = HERE,
} = {}) {
  const hash = createHash("sha1");
  const files = new Set();
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) collectSourceFiles(root).forEach((file) => files.add(file));
      else files.add(root);
    } catch { /* missing optional root */ }
  }
  for (const manifest of [webPackage, backendPackage, webLock, backendLock, buildScript]) {
    if (existsSync(manifest)) files.add(manifest);
  }
  for (const file of [...files].sort()) {
    const st = statSync(file);
    hash.update(`${relative(ROOT, file)}\0${st.size}\0${Math.trunc(st.mtimeMs)}\n`);
  }
  return hash.digest("hex");
}

export function backendRuntimeBundleIsCurrent({
  bundlePath = BUNDLE_PATH,
  stampPath = BUNDLE_STAMP_PATH,
  sourceStamp = backendRuntimeSourceStamp(),
} = {}) {
  if (!existsSync(bundlePath) || !existsSync(stampPath)) return false;
  try {
    return readFileSync(stampPath, "utf8").trim() === sourceStamp;
  } catch {
    return false;
  }
}

/** Publish only a fully compiled bundle; roll back all artifacts if a write fails. */
export function publishRuntimeBuild({ outputFiles, stampPath, sourceStamp, write = writeFileSync }) {
  const artifacts = [...outputFiles, { path: stampPath, contents: Buffer.from(`${sourceStamp}\n`) }];
  const previous = artifacts.map(({ path }) => existsSync(path) ? readFileSync(path) : null);
  try {
    for (const { path, contents } of artifacts) write(path, contents);
  } catch (err) {
    for (let i = 0; i < artifacts.length; i += 1) {
      if (previous[i] === null) rmSync(artifacts[i].path, { force: true });
      else writeFileSync(artifacts[i].path, previous[i]);
    }
    throw err;
  }
}

export async function buildBackendRuntime({ log = console.log, force = false } = {}) {
  const version = assertPiDependencyVersions(join(ROOT, "web"), join(ROOT, "backend"));
  for (const dir of ["web", "backend"]) assertInstalledPiVersions(join(ROOT, dir), version);
  mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
  const sourceStamp = backendRuntimeSourceStamp();
  if (!force && backendRuntimeBundleIsCurrent({ sourceStamp })) {
    const size = statSync(BUNDLE_PATH).size;
    log(`[backend-runtime] reused ${BUNDLE_PATH} (${Math.round(size / 1024)} KiB)`);
    return { outfile: BUNDLE_PATH, size, reused: true };
  }
  // esbuild is a Web devDependency (through vitest); resolve it from the Web project so the root
  // script does not need its own copy.
  const webRequire = createRequire(join(ROOT, "web", "package.json"));
  const esbuildPath = webRequire.resolve("esbuild");
  const esbuild = await import(pathToFileURL(esbuildPath).href);
  const entry = join(WEB_SRC, "lib", "pi", "backend-runtime-entry.ts");
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: BUNDLE_PATH,
    // Compile in memory: esbuild errors must leave the last good build untouched.
    write: false,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "silent",
    alias: runtimeAliases(),
    external: runtimeExternals(),
    // The harness reads `import.meta.url` and process.env at call time, so no define is needed.
    banner: {
      // Bundled CommonJS dependencies call `require` at runtime, which an ESM bundle does not
      // provide; the shim gives them the bundle's own resolver.
      js: [
        "// Generated by scripts/build-backend-runtime.mjs — do not edit.",
        'import { createRequire as __createRequire } from "node:module";',
        "const require = __createRequire(import.meta.url);",
      ].join(String.fromCharCode(10)),
    },
  }).finally(() => {
    // The Host imports this module in-process: without stop() the esbuild service child (and its
    // keep-alive ping) stays resident for the Host's whole lifetime after a one-off bundle build.
    try { void Promise.resolve(esbuild.stop?.()).catch(() => {}); } catch { /* exits with its parent */ }
  });
  if (result.errors.length > 0) {
    for (const error of result.errors) log(`[backend-runtime] ${error.text}`);
    throw new Error("Backend runtime bundle failed");
  }
  publishRuntimeBuild({ outputFiles: result.outputFiles, stampPath: BUNDLE_STAMP_PATH, sourceStamp });
  const size = statSync(BUNDLE_PATH).size;
  log(`[backend-runtime] wrote ${BUNDLE_PATH} (${Math.round(size / 1024)} KiB)`);
  return { outfile: BUNDLE_PATH, size, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) {
  mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
  buildBackendRuntime({ force: process.argv.includes("--force") }).catch((error) => {
    console.error(`Backend runtime build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
