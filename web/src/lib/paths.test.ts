import { describe, expect, it, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { noProjectRoot, noProjectSessionDir, sameOrDescendantPath, samePath } from "./paths";

const roots: string[] = [];

afterEach(() => {
  delete process.env.LEAFCODE_PI_DEFAULT_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("path identity", () => {
  it("preserves POSIX case and folds Windows case", () => {
    expect(samePath("/work/Foo", "/work/foo", "linux")).toBe(false);
    expect(samePath("C:\\work\\Foo", "c:\\WORK\\foo", "win32")).toBe(true);
  });

  it("checks descendants with platform path semantics", () => {
    expect(sameOrDescendantPath("/work/Foo/src", "/work/Foo", "linux")).toBe(true);
    expect(sameOrDescendantPath("/work/foo/src", "/work/Foo", "linux")).toBe(false);
  });
});

describe("no-project workspace paths", () => {
  it("uses minute precision and adds seconds only after a collision", () => {
    const root = join(tmpdir(), `leafcode-pi-paths-${Date.now()}`);
    roots.push(root);
    process.env.LEAFCODE_PI_DEFAULT_DIR = root;
    const date = new Date(2025, 6, 14, 15, 30, 12);

    expect(noProjectRoot()).toBe(root);
    expect(noProjectSessionDir(date)).toBe(join(root, "250714_1530"));
    expect(noProjectSessionDir(date)).toBe(join(root, "250714_153012"));
    expect(noProjectSessionDir(date)).toBe(join(root, "250714_153012_1"));
    expect(existsSync(join(root, "250714_1530"))).toBe(true);
  });
});
