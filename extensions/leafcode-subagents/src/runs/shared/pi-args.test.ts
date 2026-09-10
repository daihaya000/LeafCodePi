import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import {
	buildPiArgs,
	requireLeafcodePermissionGateExtension,
	resolveLeafcodePermissionGateExtension,
	resolvePiLaunchToolPlan,
} from "./pi-args.ts";

const tempDirs: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("resolvePiLaunchToolPlan", () => {
	it("fails closed when a retired ambient extension remains installed", () => {
		const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-retired-extension-"));
		tempDirs.push(dir);
		process.env.PI_CODING_AGENT_DIR = dir;
		mkdirSync(join(dir, "extensions", "leafcode-collaboration"), { recursive: true });
		writeFileSync(join(dir, "extensions", "leafcode-collaboration", "index.ts"), "export default () => {};", "utf8");

		assert.throws(
			() => resolvePiLaunchToolPlan({ tools: ["read"], cwd: dir }),
			/Retired extension 'leafcode-collaboration'/,
		);
	});

	it("keeps the in-repo system safety guard in child launches", () => {
		assert.throws(
			() => requireLeafcodePermissionGateExtension(undefined),
			/System safety guard extension is unavailable/,
		);
		const guard = resolveLeafcodePermissionGateExtension();
		assert.ok(guard);
		const plan = resolvePiLaunchToolPlan({
			tools: ["bash"],
			cwd: process.cwd(),
			capabilityCeiling: {
				version: 1,
				denyExtensions: true,
				sources: ["test"],
			},
		});

		assert.ok(plan.runtimeExtensions.includes(guard));
		assert.ok(plan.extensionArgs.includes(guard));
	});

	it("filters an explicitly retired extension while keeping extension isolation", () => {
		const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-retired-extension-"));
		tempDirs.push(dir);
		process.env.PI_CODING_AGENT_DIR = dir;
		const retiredPath = join(dir, "legacy", "leafcode-collaboration", "index.ts");

		const plan = resolvePiLaunchToolPlan({
			tools: [retiredPath, "read"],
			extensions: [retiredPath],
			cwd: dir,
		});

		assert.equal(plan.disableAmbientExtensions, true);
		assert.deepEqual(plan.configuredExtensions, []);
		assert.deepEqual(plan.extensionArgs, plan.runtimeExtensions);
	});
});

describe("buildPiArgs skill inheritance", () => {
	it.each([true, false])("passes bundled paths only when inheritSkills=%s", (inheritSkills) => {
		const root = mkdtempSync(join(tmpdir(), "leafcode-pi-child-skill-args-"));
		tempDirs.push(root);
		const skills = join(root, "repo", "skills");
		const extensionSkills = join(root, "repo", "extensions", "leafcode-test", "skills");
		mkdirSync(skills, { recursive: true });
		mkdirSync(extensionSkills, { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		vi.stubEnv("LEAFCODE_PI_SKILLS_DIR", skills);
		vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", join(root, "repo", "extensions"));
		const result = buildPiArgs({
			baseArgs: [], task: "Check skills", sessionEnabled: false,
			inheritProjectContext: false, inheritSkills, cwd: root, tools: ["read"], extensions: [],
		});
		if (result.tempDir) tempDirs.push(result.tempDir);
		const skillPaths = result.args.flatMap((arg, index) => arg === "--skill" ? [result.args[index + 1]] : []);
		assert.deepEqual(skillPaths, inheritSkills ? [skills, extensionSkills] : []);
		assert.equal(result.args.includes("--no-skills"), !inheritSkills);
	});
});
