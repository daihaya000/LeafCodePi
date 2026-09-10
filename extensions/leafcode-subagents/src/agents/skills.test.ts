import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearSkillCache, resolveSkills } from "./skills.ts";

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
