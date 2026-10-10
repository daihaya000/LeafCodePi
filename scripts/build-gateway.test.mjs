import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gatewayGraph } from "./build-gateway.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("gateway closure is all 166 routes and 267 operations, with no Next, SDK, owner or test module", () => {
  const graph = gatewayGraph(); assert.deepEqual(graph.counts, { routes: 166, operations: 267 });
  assert.equal(graph.manifest.filter(route => route.methods.includes("GET") && !route.methods.includes("HEAD")).length, 94);
  assert.equal(graph.manifest.filter(route => !route.methods.includes("OPTIONS")).length, 165);
  for (const file of graph.sources.keys()) assert.doesNotMatch(file, /^(?:backend|host|extensions)\/|web\/src\/lib\/pi\/|\.test\./);
  assert.equal(graph.manifest.find(route => route.route === "/api/pi/latest-version").source, "web/src/app/api/pi/latest-version/route.ts");
});

test("gateway dependency gate refuses framework/SDK imports, indirect loaders, owner paths and unexpected OS capabilities", () => {
  const graph = gatewayGraph(), root = mkdtempSync(join(tmpdir(), "gateway-negative-"));
  try {
    for (const file of [...graph.sources.keys(), ...graph.declarations.keys(), "docs/plans/next-thin-phase0.json"]) {
      if (file === "gateway/src/routes.mjs") continue;
      const dest = join(root, file); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(ROOT, file), dest);
    }
    const entry = join(root, "gateway/src/index.mjs"), original = readFileSync(entry, "utf8");
    for (const code of [
      'import "next/server";', 'import "@earendil-works/pi-ai";', 'import "better-sqlite3";', 'import "../../../backend/src/index.js";',
      'import "../../web/src/lib/pi/harness.ts";', 'import "node:fs";', 'import "node:child_process";', 'import "react";',
      'const loader = require;', 'globalThis["eval"]("bad");', 'process.getBuiltinModule("fs");', 'import(process.env.GATEWAY_MODULE);',
    ]) {
      writeFileSync(entry, original + "\n" + code); assert.throws(() => gatewayGraph(root), undefined, code);
    }
    writeFileSync(entry, original);
    const route = join(root, "web/src/app/api/accounts/route.ts"), source = readFileSync(route, "utf8");
    for (const code of ['import type { NextRequest } from "next/server";', 'type Hidden = import("@earendil-works/pi-ai").Model;']) {
      writeFileSync(route, source + "\n" + code); assert.throws(() => gatewayGraph(root), undefined, code);
    }
    writeFileSync(route, source); assert.equal(gatewayGraph(root).manifest.length, 166);
    // A permitted-looking filename cannot conceal a junction/symlink to owner code.
    const escaped = join(root, "shared/escaped"); symlinkSync(join(ROOT, "host/src"), escaped, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(entry, original + '\nimport "../../shared/escaped/index.js";'); assert.throws(() => gatewayGraph(root), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
