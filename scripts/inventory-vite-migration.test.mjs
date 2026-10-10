import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkMigrationInventory, implicitMethods, sourceFacts } from "./inventory-vite-migration.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(resolve(root, "web/package.json"));
const ts = require("typescript");

test("Phase0 covers all current entries, explicit operations, source hashes and assets", () => {
  const counts = checkMigrationInventory(root);
  assert.equal(counts.routes, 165);
  assert.equal(counts.operations, 265);
  assert.deepEqual(counts.ownerCounts, { Backend: 239, Gateway: 6, Host: 20 });
  assert.equal(counts.pages, 7);
  assert.equal(counts.implicitHeadRoutes, 94);
  assert.equal(counts.implicitOptionsRoutes, 164);
});

test("implicit HEAD and OPTIONS match installed Next for every route", () => {
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js");
  const inventory = JSON.parse(readFileSync(resolve(root, "docs/plans/vite-migration-phase0.json"), "utf8"));
  for (const route of inventory.routes) {
    const handlers = Object.fromEntries(route.operations.map(({ method }) => [method, () => new Response(null, { status: 202 })]));
    const actual = autoImplementMethods(handlers);
    for (const item of route.implicit) {
      if (item.method === "HEAD") assert.equal(actual.HEAD, handlers.GET, route.route);
      else {
        const response = actual.OPTIONS();
        assert.equal(response.status, item.status, route.route);
        assert.equal(response.headers.get("allow"), item.allow, route.route);
      }
    }
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      if (!handlers[method] && !route.implicit.some(item => item.method === method)) assert.equal(actual[method]().status, 405, route.route);
    }
  }
});

test("explicit HEAD/OPTIONS are never replaced; POST-only has no implicit HEAD", () => {
  assert.deepEqual(implicitMethods(["GET", "HEAD", "OPTIONS"]), []);
  assert.deepEqual(implicitMethods(["POST"]), [{ method: "OPTIONS", status: 204, allow: "OPTIONS, POST" }]);
});

test("AST inventory includes aliased imports, inline type imports, dynamic imports and env names", () => {
  const source = `import type { NextRequest } from "next/server";
import { type Metadata } from "next";
import { NextResponse as Reply } from "next/server";
export type { Viewport } from "next";
export { type Metadata } from "next";
type Nav = import("next/navigation");
const view = import("./View");
const output = Reply.json({}); const url = request.nextUrl; const cookie = response.cookies;
const commit = process.env.NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT;`;
  const facts = sourceFacts("input.ts", source, ts);
  assert.deepEqual(facts.imports.map(item => item.kind), ["type", "type", "value", "type", "type", "type", "dynamic"]);
  assert.deepEqual(facts.frameworkUses, ["Reply.json", "request.nextUrl", "response.cookies"]);
  assert.deepEqual(facts.environmentNames, ["NEXT_PUBLIC_LEAFCODE_PI_BUILD_COMMIT"]);
});

test("comments do not count as framework imports or client directives", () => {
  const facts = sourceFacts("input.ts", `// import { NextResponse } from "next/server";
// "use client";
export const value = 1;`, ts);
  assert.deepEqual(facts.imports, []);
  assert.equal(facts.client, false);
  assert.equal(sourceFacts("input.tsx", '"use client"; export const view = <div />;', ts).client, true);
});

test("source facts are invariant under Windows checkout CRLF conversion", () => {
  const source = 'import {\n NextResponse as Reply\n} from "next/server";\n"use client";\nconst response = Reply.json({});\n';
  assert.deepEqual(sourceFacts("input.ts", source, ts), sourceFacts("input.ts", source.replaceAll("\n", "\r\n"), ts));
});

test("syntax errors and nonliteral loading are explicit inventory failures", () => {
  assert.throws(() => sourceFacts("input.ts", "import(name)", ts), /nonliteral import/);
  assert.throws(() => sourceFacts("input.ts", "const =", ts), /syntax error/);
});
