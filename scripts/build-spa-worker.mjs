import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGateway } from "./build-gateway.mjs";
import { checkBrowserBoundary } from "./production-boundary.mjs";
const root = resolve(fileURLToPath(new URL("../", import.meta.url))), stage = process.argv[2];
assert.ok(stage && isAbsolute(stage), "Explicit SPA generation stage required");
// The source/type refusal gate precedes compiler/build output; Vite also audits emitted values.
const boundary = checkBrowserBoundary(root);
const require = createRequire(join(root, "web/package.json")), ts = require("typescript");
const config = ts.readConfigFile(join(root, "web/tsconfig.spa.json"), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, "web"), undefined, join(root, "web/tsconfig.spa.json"));
assert.equal(parsed.errors.length, 0);
const program = ts.createProgram(parsed.fileNames, parsed.options), diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
assert.ok(!program.getSourceFiles().some(file => /\/node_modules\/next\/|\/src\/platform\//.test(file.fileName.replaceAll("\\", "/"))), "SPA type graph contains Next");
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const envDir = join(stage, ".empty-env"); mkdirSync(envDir);
await build({ configFile: join(root, "web/vite.config.ts"), envDir, build: { outDir: join(stage, "spa"), emptyOutDir: true } });
const gateway = buildGateway(root);
cpSync(gateway.output, join(stage, "gateway/dist"), { recursive: true });
// The scratch dotenv directory is not a published artifact.
const { rmSync } = await import("node:fs"); rmSync(envDir, { recursive: true });
console.log(JSON.stringify({ type: "spa_pair_compiled", ...gateway, typeSources: program.getSourceFiles().length, browserBoundary: boundary }));
