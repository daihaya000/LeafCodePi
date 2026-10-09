import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const esbuild = createRequire(join(ROOT, "backend/package.json"))("esbuild");
const web = (name) => JSON.stringify(join(ROOT, "web/src/lib", `${name}.ts`).replaceAll("\\", "/"));

/** No Next test alias, Backend directory, installed package or SDK is available to the child. */
test("auth and HTTP client run standalone with builtins only and no business fallback", { timeout: 10_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "leafcode-transport-standalone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = esbuild.buildSync({
    stdin: { contents: `export * as client from ${web("backend-client")};
      export * as auth from ${web("webui-auth")};
      export * as edgeAuth from ${web("webui-auth-shared")};
      export * as origin from ${web("same-origin")};`, resolveDir: ROOT, loader: "ts" },
    absWorkingDir: ROOT, alias: { "@shared": resolve(ROOT, "shared") },
    bundle: true, platform: "node", format: "esm", write: false, metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).map((file) => file.replaceAll("\\", "/"));
  assert.ok(inputs.some((file) => file.endsWith("shared/backend-http-client.ts")));
  assert.ok(inputs.every((file) => file === "<stdin>" || file.startsWith("shared/") || file.startsWith("web/src/lib/")), inputs.join("\n"));
  const external = new Set(Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((item) => item.path)));
  assert.deepEqual([...external].sort(), ["node:crypto", "node:fs"]);
  writeFileSync(join(root, "transport.mjs"), result.outputFiles[0].contents);
  const child = `
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { client, auth, edgeAuth, origin } from './transport.mjs';
const role = process.env.LEAFCODE_PI_PROCESS_ROLE;
assert.equal(role, 'next');
assert.equal(existsSync('./backend'), false);
assert.equal(existsSync('./node_modules'), false);
process.env.LEAFCODE_PI_WEBUI_AUTH = 'required';
process.env.LEAFCODE_PI_WEBUI_TOKEN = 'fixture-browser-token';
const request = (headers, url = 'http://localhost/api/tasks') => new Request(url, { headers });
assert.equal(auth.isWebUiRequestAuthorized(request({ authorization: 'Bearer fixture-browser-token' })), true);
assert.equal(auth.isWebUiRequestAuthorized(request({ cookie: 'leafcode-pi-token=fixture-browser-token' })), true);
assert.equal(auth.isWebUiRequestAuthorized(request({ authorization: 'Bearer invalid' })), false);
assert.equal(auth.isWebUiRequestAuthorized(request({}, 'http://localhost/api/tasks?token=fixture-browser-token')), false);
assert.equal(edgeAuth.tokensMatch('fixture-browser-token', 'fixture-browser-token'), true);
assert.equal(edgeAuth.tokensMatch('fixture-browser-token-extra', 'fixture-browser-token'), false);
process.env.LEAFCODE_PI_WEBUI_TOKEN = '';
assert.equal(auth.webUiAuthRequired(), true);
assert.equal(auth.isWebUiRequestAuthorized(request({ authorization: 'Bearer anything' })), false);
assert.equal(origin.isCrossOriginRequest({ headers: new Headers({ origin: 'https://outside.invalid' }), nextUrl: new URL('http://localhost/api/tasks') }), true);
assert.equal(origin.isCrossOriginRequest({ headers: new Headers({ origin: 'https://local.example', host: 'local.example' }), nextUrl: new URL('http://0.0.0.0/api/tasks') }), false);
writeFileSync('generation', 'first');
const env = { LEAFCODE_PI_BACKEND_TOKEN: 'fixture-private-token', LEAFCODE_PI_BACKEND_URL: 'http://127.0.0.1:19999/', LEAFCODE_PI_BACKEND_GENERATION_FILE: './generation', LEAFCODE_PI_BACKEND_GENERATION: 'startup' };
assert.equal(client.expectedBackendGeneration(env), 'first');
writeFileSync('generation', 'second');
assert.equal(client.expectedBackendGeneration(env), 'second');
assert.equal(client.expectedBackendGeneration({ ...env, LEAFCODE_PI_BACKEND_GENERATION_FILE: './missing' }), 'startup');
assert.equal(client.isBackendGenerationCompatible('second', 'first'), false);
let count = 0;
const fetchImpl = async (url, options) => {
  count++;
  assert.equal(url, 'http://127.0.0.1:19999/internal/tasks');
  const headers = new Headers(options.headers);
  assert.equal(headers.get('authorization'), 'Bearer fixture-private-token');
  assert.ok(headers.get('x-leafcode-backend-protocol'));
  return Response.json({ tasks: [{ id: 'from-owner' }] });
};
assert.deepEqual(await client.readBackendTasks({ env, fetchImpl }), { ok: true, status: 200, body: { tasks: [{ id: 'from-owner' }] } });
assert.equal(count, 1);
assert.deepEqual(await client.readBackendTasks({ env: {}, fetchImpl }), { ok: false, reason: 'not-configured' });
assert.equal(count, 1);
count = 0;
const result = await client.readBackendTasks({ env, fetchImpl: async () => { count++; throw new Error('offline'); } });
assert.deepEqual(result, { ok: false, reason: 'unreachable' });
assert.equal(count, 1);
assert.equal(readFileSync('generation', 'utf8'), 'second');
assert.equal(process.env.LEAFCODE_PI_PROCESS_ROLE, role);
assert.equal(existsSync('./data'), false);
console.log('standalone auth/protocol/generation/no-fallback verified');
`;
  writeFileSync(join(root, "child.mjs"), child);
  for (const mode of ["development", "production", "test"]) {
    const run = spawnSync(process.execPath, ["child.mjs"], {
      cwd: root, encoding: "utf8", timeout: 5_000,
      env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: mode, LEAFCODE_PI_PROCESS_ROLE: "next",
        LEAFCODE_PI_WEBUI_AUTH: "", LEAFCODE_PI_WEBUI_TOKEN: "", LEAFCODE_PI_BACKEND_TOKEN: "" },
    });
    assert.equal(run.status, 0, `${mode}: ${run.stderr || run.error?.message}`);
    assert.match(run.stdout, /standalone auth\/protocol\/generation\/no-fallback verified/);
  }
});

test("shared auth/client typechecks without any Backend or SDK source", () => {
  const ts = createRequire(join(ROOT, "web/package.json"))("typescript");
  const program = ts.createProgram(["backend-http-client", "webui-auth", "webui-auth-shared", "same-origin"]
    .map((name) => join(ROOT, "shared", `${name}.ts`)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, allowJs: true, types: ["node"], typeRoots: [join(ROOT, "web/node_modules/@types")],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
  const sources = program.getSourceFiles().map((source) => source.fileName.replaceAll("\\", "/"));
  assert.ok(!sources.some((file) => /\/(backend\/runtime-src|backend\/core|@earendil-works|@backend-runtime)\//.test(file)), sources.join("\n"));
});

test("Web and Backend compatibility paths reference the same shared contracts", () => {
  for (const [legacy, shared] of [["backend-client", "backend-http-client"], ["webui-auth", "webui-auth"],
    ["webui-auth-shared", "webui-auth-shared"], ["same-origin", "same-origin"]]) {
    const pattern = new RegExp(`export \\* from "@shared/${shared}";`);
    for (const prefix of ["web/src/lib", "backend/runtime-src/lib"]) {
      assert.match(readFileSync(join(ROOT, prefix, `${legacy}.ts`), "utf8"), pattern);
    }
  }
});
