import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveVerifyCwd } from "./acceptance.ts";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function workspace(): { base: string; outside: string } {
	root = mkdtempSync(join(tmpdir(), "acceptance-cwd-"));
	const base = join(root, "work");
	const outside = join(root, "outside");
	mkdirSync(join(base, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	return { base, outside };
}

it("defaults to the working directory and accepts paths inside it", () => {
	const { base } = workspace();
	expect(resolveVerifyCwd(base, undefined)).toBe(base);
	expect(resolveVerifyCwd(base, ".")).toBe(resolve(base));
	expect(resolveVerifyCwd(base, "sub")).toBe(join(base, "sub"));
});

it("rejects relative and absolute paths that leave the working directory", () => {
	const { base, outside } = workspace();
	expect(resolveVerifyCwd(base, "..")).toBeUndefined();
	expect(resolveVerifyCwd(base, "../outside")).toBeUndefined();
	expect(resolveVerifyCwd(base, "sub/../../outside")).toBeUndefined();
	expect(resolveVerifyCwd(base, outside)).toBeUndefined();
});

it("rejects a symlink inside the working directory that points outside", (context) => {
	const { base, outside } = workspace();
	try {
		symlinkSync(outside, join(base, "link"), "junction");
	} catch {
		context.skip();
		return;
	}
	expect(resolveVerifyCwd(base, "link")).toBeUndefined();
});
