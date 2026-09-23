import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMAND_TIMEOUT_MS = 15_000;

export const LINUX_HELPER_PROTOCOL_VERSION = 4;
export const LINUX_HELPER_PATH = process.env.LEAFCODE_COMPUTER_USE_LINUX_HELPER_PATH
	|| path.join(PACKAGE_ROOT, "prebuilt", "linux", process.arch === "arm64" ? "arm64" : "x64", "linux-bridge");

interface Pending<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

async function isExecutable(filePath: string): Promise<boolean> {
	try { await access(filePath, fsConstants.X_OK); return true; } catch { return false; }
}

async function waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return await promise;
	if (signal.aborted) throw new Error("Operation aborted.");
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Operation aborted."));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export interface LinuxHelperClientOptions {
	helperPath?: string;
}

export class LinuxHelperClient {
	private child?: ChildProcessWithoutNullStreams;
	private processPromise?: Promise<ChildProcessWithoutNullStreams>;
	private buffer = "";
	private pending = new Map<string, Pending<unknown>>();
	private readonly helperPath: string;

	constructor(options: LinuxHelperClientOptions = {}) {
		this.helperPath = options.helperPath ?? LINUX_HELPER_PATH;
	}

	dispose(): void {
		this.rejectPending(new Error("Linux helper closed because the Pi session ended."));
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		child.kill("SIGTERM");
		child.unref();
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.buffer = "";
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Operation aborted.");
		if (!(await isExecutable(this.helperPath))) {
			throw new Error(`Linux helper unavailable or not executable at ${this.helperPath}; no automatic installation is performed.`);
		}
	}

	private async process(signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
		await this.ensureInstalled(signal);
		if (this.processPromise) return await waitForShared(this.processPromise, signal);
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		if (!this.processPromise) {
			const processPromise = this.startProcess();
			this.processPromise = processPromise;
			processPromise.then(
				() => { if (this.processPromise === processPromise) this.processPromise = undefined; },
				() => { if (this.processPromise === processPromise) this.processPromise = undefined; },
			);
		}
		return await waitForShared(this.processPromise, signal);
	}

	private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
		const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdin.setDefaultEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.on("exit", (code, signalName) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.rejectPending(new Error(`Linux helper exited${signalName ? ` on ${signalName}` : ` with code ${code ?? "unknown"}`}.`));
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.rejectPending(error);
		});
		this.child = child;
		this.buffer = "";
		return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
			child.once("spawn", () => resolve(child));
			child.once("error", reject);
		});
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let parsed: any;
			try { parsed = JSON.parse(line); } catch { continue; }
			const pending = this.pending.get(parsed.id);
			if (!pending) continue;
			this.pending.delete(parsed.id);
			clearTimeout(pending.timer);
			if (parsed.protocolVersion !== LINUX_HELPER_PROTOCOL_VERSION) {
				pending.reject(new Error(`Linux helper protocol mismatch: expected ${LINUX_HELPER_PROTOCOL_VERSION}, got ${parsed.protocolVersion ?? "unknown"}. Restart Pi to use the installed helper.`));
			} else if (parsed.ok === true) {
				pending.resolve(parsed.result);
			} else {
				const error = new Error(parsed.error?.message ?? "Linux helper command failed.") as Error & { code?: string };
				error.code = parsed.error?.code;
				pending.reject(error);
			}
		}
	}

	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const child = await this.process(options?.signal);
		const id = randomUUID();
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		return await new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error("Operation aborted."));
			};
			const timer = setTimeout(() => {
				options?.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				reject(new Error(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => { options?.signal?.removeEventListener("abort", onAbort); resolve(value as T); },
				reject: (error) => { options?.signal?.removeEventListener("abort", onAbort); reject(error); },
				timer,
			});
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdin.write(`${JSON.stringify({ protocolVersion: LINUX_HELPER_PROTOCOL_VERSION, id, cmd, args })}\n`, (error) => {
				if (!error) return;
				options?.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}
}

export const linuxHelper = new LinuxHelperClient();
