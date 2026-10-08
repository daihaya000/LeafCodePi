import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The old path's narrowest point.
 *
 * Phase 6 removes the WebUI's own runtime ownership, and the removal is only safe while the number
 * of places that can create a Pi session is known: one call site, behind the ownership guard. This
 * test is the executable inventory — it fails when a second creation site appears, and it shrinks
 * to nothing when the owner path is deleted.
 */
const SRC_DIR = join(__dirname, "..", "..", "..", "..", "backend", "runtime-src");
/** A real call, not a type reference (`ReturnType<PiModule["createAgentSession"]>` is a type). */
const SESSION_CREATION = /createAgentSession\s*\(/;

function sourceFiles(dir = SRC_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/** Comments mention the SDK too; only real code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function sessionCreationSites(): string[] {
  return sourceFiles()
    .filter((file) => SESSION_CREATION.test(stripComments(readFileSync(file, "utf8"))))
    .map((file) => relative(SRC_DIR, file).replace(/\\/g, "/"))
    .sort();
}

describe("Pi session creation surface", () => {
  it("creates sessions in exactly one module", () => {
    expect(sessionCreationSites()).toEqual(["lib/pi/harness.ts"]);
  });

  it("guards that module's creation site with the ownership rule", () => {
    const harness = stripComments(readFileSync(join(SRC_DIR, "lib", "pi", "harness.ts"), "utf8"));
    // The guard sits in `createSession`, immediately before the SDK is loaded: every caller of the
    // single creation site is refused in a process that does not own the runtime.
    expect(harness).toMatch(/assertLocalRuntimeAllowed\(\);\s*\n\s*const loadPiStartedAt/);
    expect(harness).toMatch(/sdkRuntimeFactory\(\)\.createAgentSession\(/);
  });
});
