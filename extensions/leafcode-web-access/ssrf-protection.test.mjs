import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("trustEnvProxy does not bypass local DNS and private-address checks", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "web-access-ssrf-test-"));
	const envKeys = [
		"PI_CODING_AGENT_DIR",
		"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
		"ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
	];
	const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

	try {
		process.env.PI_CODING_AGENT_DIR = configDir;
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "";
		process.env.no_proxy = "";
		for (const key of ["HTTP_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
			delete process.env[key];
		}

		const { validateRemoteUrl } = await import("./ssrf-protection.ts");
		const lookups = [];
		await assert.rejects(
			validateRemoteUrl("https://public.example", {
				trustEnvProxy: true,
				lookup: async (hostname) => {
					lookups.push(hostname);
					return [{ address: "10.1.2.3", family: 4 }];
				},
			}),
			/Blocked internal address for public\.example: 10\.1\.2\.3/,
		);
		assert.deepEqual(lookups, ["public.example"]);
	} finally {
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(configDir, { recursive: true, force: true });
	}
});
