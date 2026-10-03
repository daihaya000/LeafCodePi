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

test("fetchRemoteUrl pins redirect DNS answers and awaits per-hop request hooks", async () => {
	const received = [];
	const server = createServer((request, response) => {
		received.push({ host: request.headers.host, cookie: request.headers.cookie });
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
	const callbackOrder = [];
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
			beforeRequest: async (current, requestInit) => {
				callbackOrder.push(`request:${current.hostname}`);
				const headers = new Headers(requestInit.headers);
				headers.set("cookie", `test=${current.hostname}`);
				await Promise.resolve();
				return { ...requestInit, headers };
			},
			onRedirect: async ({ from, to, init }) => {
				callbackOrder.push(`redirect:${from.hostname}->${to.hostname}`);
				await Promise.resolve();
				return init;
			},
		});
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "pinned");
		assert.equal(lookups, 2, "each redirect host is validated once and then connected through its pinned address");
		assert.deepEqual(callbackOrder, [
			"request:pin-rebind.test",
			"redirect:pin-rebind.test->pin-redirect.test",
			"request:pin-redirect.test",
		]);
		assert.deepEqual(received, [
			{ host: `pin-rebind.test:${address.port}`, cookie: "test=pin-rebind.test" },
			{ host: `pin-redirect.test:${address.port}`, cookie: "test=pin-redirect.test" },
		]);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("trustEnvProxy pins each redirect hop and preserves Host and cookies", async () => {
	const received = [];
	const server = createServer((request, response) => {
		received.push({ target: request.url, host: request.headers.host, cookie: request.headers.cookie });
		if (new URL(request.url).pathname === "/start") {
			response.writeHead(302, { location: "http://proxy-redirect.test:4567/final" });
			response.end("redirect");
			return;
		}
		response.end("pinned through proxy");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const envKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
	const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	process.env.HTTP_PROXY = process.env.http_proxy = `http://127.0.0.1:${address.port}`;
	process.env.HTTPS_PROXY = process.env.https_proxy = "";
	process.env.NO_PROXY = process.env.no_proxy = "";

	const lookups = [];
	try {
		const { fetchRemoteUrl } = await import("./ssrf-protection.ts");
		const response = await fetchRemoteUrl("http://proxy-origin.test:4567/start", {}, {
			trustEnvProxy: true,
			allowRanges: ["127.0.0.0/8"],
			lookup: async (hostname) => {
				lookups.push(hostname);
				return [{ address: "127.0.0.1", family: 4 }];
			},
			beforeRequest: async (url, init) => {
				const headers = new Headers(init.headers);
				headers.set("cookie", `session=${url.hostname}`);
				return { ...init, headers };
			},
		});
		assert.equal(response.status, 200);
		assert.equal(response.url, "http://proxy-redirect.test:4567/final");
		assert.equal(await response.text(), "pinned through proxy");
		assert.deepEqual(lookups, ["proxy-origin.test", "proxy-redirect.test"]);
		assert.deepEqual(received, [
			{ target: "http://127.0.0.1:4567/start", host: "proxy-origin.test:4567", cookie: "session=proxy-origin.test" },
			{ target: "http://127.0.0.1:4567/final", host: "proxy-redirect.test:4567", cookie: "session=proxy-redirect.test" },
		]);
	} finally {
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("trustEnvProxy respects NO_PROXY while retaining the pinned direct transport", async () => {
	const targetRequests = [];
	const target = createServer((request, response) => {
		targetRequests.push(request.url);
		response.end("direct due to NO_PROXY");
	});
	const proxyRequests = [];
	const proxy = createServer((request, response) => {
		proxyRequests.push(request.url);
		response.end("unexpected proxy");
	});
	await Promise.all([
		new Promise((resolve) => target.listen(0, "127.0.0.1", resolve)),
		new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
	]);
	const targetAddress = target.address();
	const proxyAddress = proxy.address();
	assert.ok(targetAddress && typeof targetAddress !== "string");
	assert.ok(proxyAddress && typeof proxyAddress !== "string");
	const envKeys = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
	const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	process.env.HTTP_PROXY = process.env.http_proxy = `http://127.0.0.1:${proxyAddress.port}`;
	process.env.NO_PROXY = process.env.no_proxy = `unrelated.test *.no-proxy.test:${targetAddress.port}`;

	try {
		const { fetchRemoteUrl } = await import("./ssrf-protection.ts");
		const response = await fetchRemoteUrl(`http://sub.no-proxy.test:${targetAddress.port}/path`, {}, {
			trustEnvProxy: true,
			allowRanges: ["127.0.0.0/8"],
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		assert.equal(await response.text(), "direct due to NO_PROXY");
		assert.deepEqual(targetRequests, ["/path"]);
		assert.deepEqual(proxyRequests, []);
	} finally {
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await Promise.all([
			new Promise((resolve, reject) => target.close((error) => error ? reject(error) : resolve())),
			new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())),
		]);
	}
});

test("trustEnvProxy pins HTTPS CONNECT to the validated IP and keeps original SNI", async () => {
	const server = createServer();
	let connectTarget;
	let clientHello = Buffer.alloc(0);
	server.on("connect", (request, socket) => {
		connectTarget = request.url;
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.on("data", (chunk) => {
			clientHello = Buffer.concat([clientHello, chunk]);
			socket.destroy();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const envKeys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
	const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	process.env.HTTPS_PROXY = process.env.https_proxy = `http://127.0.0.1:${address.port}`;
	process.env.NO_PROXY = process.env.no_proxy = "";

	try {
		const { fetchRemoteUrl } = await import("./ssrf-protection.ts");
		await assert.rejects(
			fetchRemoteUrl("https://tls-origin.test:4567/path", { signal: AbortSignal.timeout(5000) }, {
				trustEnvProxy: true,
				allowRanges: ["127.0.0.0/8"],
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			}),
		);
		assert.equal(connectTarget, "127.0.0.1:4567");
		assert.ok(clientHello.includes(Buffer.from("tls-origin.test")), "TLS ClientHello retains the original hostname as SNI");
	} finally {
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("auth redirect guard runs before preparing cookies for the next hop", async () => {
	const requestedPaths = [];
	const server = createServer((request, response) => {
		requestedPaths.push(request.url);
		response.writeHead(302, { location: `http://auth-redirect.test:${server.address().port}/final` });
		response.end("redirect");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");

	const preparedHosts = [];
	try {
		const [{ fetchRemoteUrl }, { authFetchRedirectGuard }] = await Promise.all([
			import("./ssrf-protection.ts"),
			import("./auth-fetch.ts"),
		]);
		const profile = { name: "test", hosts: ["auth-origin.test"], redirects: "same-origin", cache: "off" };
		await assert.rejects(
			fetchRemoteUrl(`http://auth-origin.test:${address.port}/start`, { signal: AbortSignal.timeout(5000) }, {
				allowRanges: ["127.0.0.0/8"],
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
				beforeRequest: async (url, init) => {
					preparedHosts.push(url.hostname);
					return init;
				},
				onRedirect: ({ from, to, init }) => {
					authFetchRedirectGuard(profile, from, to);
					return init;
				},
			}),
			/Authenticated fetch refused cross-origin redirect/,
		);
		assert.deepEqual(preparedHosts, ["auth-origin.test"]);
		assert.deepEqual(requestedPaths, ["/start"]);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
