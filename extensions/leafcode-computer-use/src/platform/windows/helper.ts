import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_HELPER_LINE_BYTES = 32 * 1024 * 1024;

export const WINDOWS_HELPER_PROTOCOL_VERSION = 4;
export const WINDOWS_HELPER_PATH = process.env.LEAFCODE_COMPUTER_USE_WINDOWS_HELPER_PATH || path.join(PACKAGE_ROOT, "prebuilt", "windows", "windows-bridge.exe");

interface Pending<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export interface WindowsHelperClientOptions {
	helperPath?: string;
	spawnProcess?: typeof spawn;
}

async function waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return await promise;
	if (signal.aborted) throw new Error("Operation aborted.");
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Operation aborted."));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
}

async function isAvailable(filePath: string): Promise<boolean> {
	try {
		// A Windows .exe checked on POSIX is present but intentionally not executable there.
		await access(filePath, process.platform === "win32" ? fsConstants.X_OK : fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export class WindowsHelperClient {
	private child?: ChildProcessWithoutNullStreams;
	private processPromise?: Promise<ChildProcessWithoutNullStreams>;
	private buffer = "";
	private bufferBytes = 0;
	private pending = new Map<string, Pending<unknown>>();
	private readonly helperPath: string;
	private readonly spawnProcess: typeof spawn;

	constructor(options: WindowsHelperClientOptions = {}) {
		this.helperPath = options.helperPath ?? WINDOWS_HELPER_PATH;
		this.spawnProcess = options.spawnProcess ?? spawn;
	}

	dispose(): void {
		this.rejectPending(new Error("Windows helper closed because the Pi session ended."));
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
		this.bufferBytes = 0;
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Operation aborted.");
		if (!(await isAvailable(this.helperPath))) {
			throw new Error(`Windows helper unavailable at ${this.helperPath}; no automatic installation is performed.`);
		}
	}

	private async process(signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
		await this.ensureInstalled(signal);
		if (this.processPromise) return await waitForShared(this.processPromise, signal);
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		const processPromise = this.startProcess();
		this.processPromise = processPromise;
		processPromise.then(
			() => { if (this.processPromise === processPromise) this.processPromise = undefined; },
			() => { if (this.processPromise === processPromise) this.processPromise = undefined; },
		);
		return await waitForShared(processPromise, signal);
	}

	private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
		const child = this.spawnProcess(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.resume();
		child.stdin.setDefaultEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.on("exit", (code, signalName) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.rejectPending(new Error(`Windows helper exited${signalName ? ` on ${signalName}` : ` with code ${code ?? "unknown"}`}.`));
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.rejectPending(error);
		});
		this.child = child;
		this.buffer = "";
		this.bufferBytes = 0;
		return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
			child.once("spawn", () => resolve(child));
			child.once("error", reject);
		});
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		this.bufferBytes += Buffer.byteLength(chunk, "utf8");
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) {
				if (this.bufferBytes > MAX_HELPER_LINE_BYTES) this.failHelper(new Error("Windows helper response exceeded the 32 MiB line limit."));
				return;
			}
			const rawLine = this.buffer.slice(0, newline);
			const rawLineBytes = Buffer.byteLength(rawLine, "utf8");
			if (rawLineBytes > MAX_HELPER_LINE_BYTES) {
				this.failHelper(new Error("Windows helper response exceeded the 32 MiB line limit."));
				return;
			}
			const line = rawLine.trim();
			this.buffer = this.buffer.slice(newline + 1);
			this.bufferBytes -= rawLineBytes + 1;
			if (!line) continue;
			let parsed: any;
			try { parsed = JSON.parse(line); } catch { continue; }
			const pending = this.pending.get(parsed.id);
			if (!pending) continue;
			this.pending.delete(parsed.id);
			clearTimeout(pending.timer);
			if (parsed.protocolVersion !== WINDOWS_HELPER_PROTOCOL_VERSION) {
				pending.reject(new Error(`Windows helper protocol mismatch: expected ${WINDOWS_HELPER_PROTOCOL_VERSION}, got ${parsed.protocolVersion ?? "unknown"}. Restart Pi to use the installed helper.`));
			} else if (parsed.ok === true) {
				pending.resolve(parsed.result);
			} else {
				const error = new Error(parsed.error?.message ?? "Windows helper command failed.") as Error & { code?: string };
				error.code = parsed.error?.code;
				pending.reject(error);
			}
		}
	}

	private failHelper(error: Error): void {
		const child = this.child;
		this.child = undefined;
		this.rejectPending(error);
		if (child && !child.killed) child.kill("SIGTERM");
	}

	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const child = await this.process(options?.signal);
		if (options?.signal?.aborted) throw new Error("Operation aborted.");
		const id = randomUUID();
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		return await new Promise<T>((resolve, reject) => {
			const signal = options?.signal;
			let timer: NodeJS.Timeout;
			const cleanup = () => signal?.removeEventListener("abort", onAbort);
			const onAbort = () => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				cleanup();
				reject(new Error("Operation aborted."));
			};
			timer = setTimeout(() => {
				this.pending.delete(id);
				cleanup();
				reject(new Error(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => { cleanup(); resolve(value as T); },
				reject: (error) => { cleanup(); reject(error); },
				timer,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) { onAbort(); return; }
			child.stdin.write(`${JSON.stringify({ protocolVersion: WINDOWS_HELPER_PROTOCOL_VERSION, id, cmd, args })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				clearTimeout(timer);
				cleanup();
				reject(error);
			});
		});
	}
}

export const windowsHelper = new WindowsHelperClient();
