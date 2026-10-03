import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("fetchRemoteUrl pins each redirect hop to its validated DNS result", async () => {
	const server = createServer((request, response) => {
		if (request.url === "/start") {
			response.writeHead(302, { location: `http://pin-redirect.test:${server.address().port}/final` });
			response.end("redirect");
			return;
		}
		response.end("pinned");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");

	let lookups = 0;
	try {
		const { fetchRemoteUrl } = await import("./ssrf-protection.ts");
		const response = await fetchRemoteUrl(`http://pin-rebind.test:${address.port}/start`, {
			signal: AbortSignal.timeout(5000),
		}, {
			allowRanges: ["127.0.0.0/8"],
			fetch: globalThis.fetch,
			lookup: async (hostname) => {
				lookups++;
				assert.equal(hostname, lookups === 1 ? "pin-rebind.test" : "pin-redirect.test");
				return [{ address: "127.0.0.1", family: 4 }];
			},
		});
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "pinned");
		assert.equal(lookups, 2, "each redirect host is validated once and then connected through its pinned address");
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
