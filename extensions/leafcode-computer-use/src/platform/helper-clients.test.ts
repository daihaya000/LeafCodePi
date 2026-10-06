import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxHelperClient } from "./linux/helper.ts";
import { WindowsHelperClient } from "./windows/helper.ts";

interface HelperClient {
	command<T>(cmd: string, args?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
	dispose(): void;
}

interface HelperRequest {
	protocolVersion: number;
	id: string;
	cmd: string;
}

function fakeSpawn(options: { respond?: boolean; stderrBytes?: number } = {}) {
	let child: any;
	let resolveRequest!: (request: HelperRequest) => void;
	const received = new Promise<HelperRequest>((resolve) => { resolveRequest = resolve; });
	const spawnProcess = (() => {
		child = new EventEmitter();
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough({ highWaterMark: 1024 });
		child.exitCode = null;
		child.killed = false;
		child.kill = () => { child.killed = true; return true; };
		child.unref = () => child;
		child.stdin.on("data", (chunk: Buffer) => {
			const request = JSON.parse(chunk.toString("utf8")) as HelperRequest;
			resolveRequest(request);
			if (options.stderrBytes) child.stderr.write("x".repeat(options.stderrBytes));
			if (options.respond) {
				const response = `${JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result: { cmd: request.cmd, text: "日本語" } })}\n`;
				child.stdout.write(response.slice(0, 7));
				child.stdout.write(response.slice(7));
			}
		});
		queueMicrotask(() => child.emit("spawn"));
		return child as ChildProcessWithoutNullStreams;
	}) as unknown as typeof spawn;
	return {
		spawnProcess,
		received,
		get child() { return child; },
	};
}

const clientCases: Array<{
	name: string;
	create: (options: { helperPath: string; spawnProcess: typeof spawn }) => HelperClient;
}> = [
	{ name: "Windows", create: (options) => new WindowsHelperClient(options) },
	{ name: "Linux", create: (options) => new LinuxHelperClient(options) },
];

describe.each(clientCases)("$name helper transport", ({ create }) => {
	let client: HelperClient | undefined;
	let tempDirectory: string | undefined;

	afterEach(() => {
		client?.dispose();
		client = undefined;
		if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
		tempDirectory = undefined;
	});

	function fixturePath(): string {
		tempDirectory = mkdtempSync(path.join(tmpdir(), "leafcode-cu-helper-test-"));
		const helperPath = path.join(tempDirectory, "helper");
		writeFileSync(helperPath, "fixture");
		chmodSync(helperPath, 0o755);
		return helperPath;
	}

	it("drains stderr and resolves protocol responses", async () => {
		const harness = fakeSpawn({ respond: true, stderrBytes: 256 * 1024 });
		client = create({ helperPath: fixturePath(), spawnProcess: harness.spawnProcess });

		await expect(client.command<{ cmd: string; text: string }>("diagnostics")).resolves.toEqual({ cmd: "diagnostics", text: "日本語" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect((await harness.received).cmd).toBe("diagnostics");
		expect(harness.child.stderr.readableLength).toBe(0);
	});

	it("rejects in-flight commands immediately when the helper exits", async () => {
		const harness = fakeSpawn();
		client = create({ helperPath: fixturePath(), spawnProcess: harness.spawnProcess });
		const result = client.command("pending", {}, { timeoutMs: 10_000 });
		await harness.received;
		harness.child.emit("exit", 2, null);

		await expect(result).rejects.toThrow(/helper exited/i);
	});

	it("honors abort signals after dispatch", async () => {
		const harness = fakeSpawn();
		client = create({ helperPath: fixturePath(), spawnProcess: harness.spawnProcess });
		const controller = new AbortController();
		const result = client.command("pending", {}, { timeoutMs: 10_000, signal: controller.signal });
		await harness.received;
		controller.abort();

		await expect(result).rejects.toThrow("Operation aborted.");
	});
});
