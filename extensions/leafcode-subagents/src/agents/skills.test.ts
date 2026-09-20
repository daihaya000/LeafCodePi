import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearSkillCache, discoverAvailableSkills, readDisabledSkillNames, resolveSkills } from "./skills.ts";

let root = "";
afterEach(() => {
	vi.unstubAllEnvs();
	clearSkillCache();
	if (root) rmSync(root, { recursive: true, force: true });
});

it("resolves repository and extension skills from an unrelated child cwd without global copies", () => {
	root = mkdtempSync(join(tmpdir(), "leafcode-child-skills-"));
	const cwd = join(root, "unrelated-project");
	mkdirSync(cwd);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", root);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("LEAFCODE_PI_SKILLS_DIR", join(root, "repo", "skills"));
	vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", join(root, "repo", "extensions"));
	const paths = [
		join(root, "repo", "skills", "bundled-test-root", "SKILL.md"),
		join(root, "repo", "extensions", "leafcode-test", "skills", "bundled-test-extension", "SKILL.md"),
	];
	for (const [index, filePath] of paths.entries()) {
		const name = index === 0 ? "bundled-test-root" : "bundled-test-extension";
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, `---\nname: ${name}\ndescription: Bundled procedure\n---\nUse this procedure.\n`, "utf8");
	}
	writeFileSync(join(root, "repo", "extensions", "leafcode-test", "index.ts"), "export default () => {};\n", "utf8");
	const result = resolveSkills(["bundled-test-root", "bundled-test-extension"], cwd);
	expect(result.missing).toEqual([]);
	expect(result.resolved.map((skill) => skill.path)).toEqual(paths);
});

it("treats settings-disabled skills as missing and hides them from discovery", () => {
	root = mkdtempSync(join(tmpdir(), "leafcode-disabled-skills-"));
	const cwd = join(root, "project");
	mkdirSync(cwd);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
	vi.stubEnv("LEAFCODE_PI_SKILLS_DIR", join(root, "repo", "skills"));
	vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", join(root, "repo", "extensions"));
	mkdirSync(join(root, "repo", "skills", "alpha"), { recursive: true });
	writeFileSync(join(root, "repo", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha procedure\n---\nDo alpha.\n", "utf8");
	mkdirSync(join(root, "data"), { recursive: true });
	writeFileSync(join(root, "data", "skills-state.json"), JSON.stringify({ code: { alpha: true }, bot: {} }), "utf8");
	expect(readDisabledSkillNames()).toEqual(new Set(["alpha"]));
	const result = resolveSkills(["alpha"], cwd);
	expect(result.resolved).toEqual([]);
	expect(result.missing).toEqual(["alpha"]);
	expect(discoverAvailableSkills(cwd).map((skill) => skill.name)).not.toContain("alpha");
});

it("ignores a missing or malformed skills state", () => {
	root = mkdtempSync(join(tmpdir(), "leafcode-no-state-"));
	vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "absent"));
	expect(readDisabledSkillNames()).toEqual(new Set());
});
