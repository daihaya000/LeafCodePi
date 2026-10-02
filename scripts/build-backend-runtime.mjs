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
 * Packages that must stay external. Both Pi packages are pinned by the Backend's own package.json,
 * and Node builtins are never bundled.
 */
export function runtimeExternals() {
  return ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "node:*"];
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
 */
export function backendRuntimeSourceStamp({
  roots = [WEB_SRC, CORE, SHARED],
  webPackage = join(ROOT, "web", "package.json"),
  backendPackage = join(ROOT, "backend", "package.json"),
} = {}) {
  const hash = createHash("sha1");
  const files = new Set();
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) collectSourceFiles(root).forEach((file) => files.add(file));
      else files.add(root);
    } catch { /* missing optional root */ }
  }
  for (const manifest of [webPackage, backendPackage]) {
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
  });
  if (result.errors.length > 0) {
    for (const error of result.errors) log(`[backend-runtime] ${error.text}`);
    throw new Error("Backend runtime bundle failed");
  }
  writeFileSync(BUNDLE_STAMP_PATH, `${sourceStamp}\n`, "utf8");
  const size = statSync(BUNDLE_PATH).size;
  log(`[backend-runtime] wrote ${BUNDLE_PATH} (${Math.round(size / 1024)} KiB)`);
  return { outfile: BUNDLE_PATH, size, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) {
  mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
  buildBackendRuntime({ force: process.argv.includes("--force") }).catch((error) => {
    rmSync(BUNDLE_PATH, { force: true });
    rmSync(BUNDLE_STAMP_PATH, { force: true });
    console.error(`Backend runtime build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
