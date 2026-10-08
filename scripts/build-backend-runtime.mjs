/**
 * Bundles the Pi runtime for the Backend process.
 *
 * Backend owns runtime-src/, dependencies and compilation. Web imports compatibility adapters;
 * neither its sources nor its installed packages are inputs to this build. The Pi SDK and AI
 * stay external so the bundle never embeds a second Pi generation.
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
import { assertInstalledPiVersions, assertPiProjectVersions, PI_SDK_PACKAGE } from "../shared/pi-dependencies.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");
const BACKEND = join(ROOT, "backend");
const RUNTIME_SRC = join(BACKEND, "runtime-src");
const CORE = join(ROOT, "backend", "core");
const SHARED = join(ROOT, "shared");
export const BUNDLE_PATH = join(ROOT, "backend", "runtime", "runtime.bundle.mjs");
export const BUNDLE_STAMP_PATH = `${BUNDLE_PATH}.stamp`;

/** The same neutral aliases resolve only Backend/shared/extension sources in this build. */
export function runtimeAliases() {
  return {
    "@": RUNTIME_SRC,
    "@backend-runtime": RUNTIME_SRC,
    "@backend-core": CORE,
    "@shared": SHARED,
    "@extensions": join(ROOT, "extensions"),
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
 * Only Backend, shared contracts and the two imported extension APIs are inputs. UI sources and
 * Web manifests/lockfiles cannot invalidate this stamp. Include the Backend compiler config,
 * dependency lockfile and this script so resolver/compiler changes rebuild the artifact.
 */
export function backendRuntimeSourceStamp({
  roots = [RUNTIME_SRC, CORE, SHARED,
    join(ROOT, "extensions", "leafcode-subagents", "src", "api", "background-work.ts"),
    join(ROOT, "extensions", "leafcode-todowrite", "visibility.ts")],
  backendPackage = join(BACKEND, "package.json"),
  backendLock = join(BACKEND, "package-lock.json"),
  compilerConfig = join(BACKEND, "tsconfig.runtime.json"),
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
  for (const manifest of [backendPackage, backendLock, compilerConfig, buildScript]) {
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

/** Fail closed if a future import reintroduces Web sources or dependencies. */
export function assertBackendInputs(metafile) {
  const forbidden = Object.keys(metafile.inputs).filter((input) => {
    const path = relative(ROOT, resolve(input)).replaceAll("\\", "/");
    return path === "web" || path.startsWith("web/");
  });
  if (forbidden.length) throw new Error(`Backend build depends on Web: ${forbidden.join(", ")}`);
}

export async function buildBackendRuntime({ log = console.log, force = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(BACKEND, "package-lock.json"), "utf8"));
  const version = manifest.dependencies?.[PI_SDK_PACKAGE];
  assertPiProjectVersions(manifest, lock, version, "Backend");
  assertInstalledPiVersions(BACKEND, version);
  mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
  const sourceStamp = backendRuntimeSourceStamp();
  if (!force && backendRuntimeBundleIsCurrent({ sourceStamp })) {
    const size = statSync(BUNDLE_PATH).size;
    log(`[backend-runtime] reused ${BUNDLE_PATH} (${Math.round(size / 1024)} KiB)`);
    return { outfile: BUNDLE_PATH, size, reused: true };
  }
  const backendRequire = createRequire(join(BACKEND, "package.json"));
  const esbuildPath = backendRequire.resolve("esbuild");
  const esbuild = await import(pathToFileURL(esbuildPath).href);
  const entry = join(RUNTIME_SRC, "lib", "pi", "backend-runtime-entry.ts");
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
    tsconfig: join(BACKEND, "tsconfig.runtime.json"),
    metafile: true,
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
  assertBackendInputs(result.metafile);
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
