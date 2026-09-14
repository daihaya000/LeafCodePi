import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncStatus } from "../../shared/types.ts";

const boundary = vi.hoisted(() => ({
	spawn: vi.fn(),
	control: undefined as undefined | { onStop(): void; onTimeout(): void; onInterrupt(): void },
	dispose: vi.fn(),
}));
// Process launch, Pi argument construction and control delivery are faked.
// The CLI entry, parser, deadlines, budgets, scheduling and persistence are real.
vi.mock("node:child_process", () => ({ spawn: boundary.spawn, spawnSync: vi.fn(() => { throw new Error("Unexpected subprocess"); }) }));
vi.mock("../shared/pi-spawn.ts", () => ({ getPiSpawnCommand: (args: string[]) => ({ command: "fake-pi", args }) }));
vi.mock("../shared/pi-args.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../shared/pi-args.ts")>(),
	buildPiArgs: () => ({ args: [], env: {} }),
}));
vi.mock("./control-channel.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("./control-channel.ts")>(),
	watchAsyncControlInbox: (_dir: string, callbacks: typeof boundary.control) => {
		boundary.control = callbacks;
		return boundary.dispose;
	},
}));

class Child extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: string | null = null;
	closed = false;
	kill = vi.fn((signal: string) => {
		queueMicrotask(() => this.close(null, signal));
		return true;
	});
	message(text = "done", tokens = 0, stopReason = "stop") {
		this.stdout.write(`${JSON.stringify({ type: "message_end", message: {
			role: "assistant", content: [{ type: "text", text }], stopReason,
			usage: { input: tokens, output: 0, cost: { total: 0 } },
		} })}\n`);
	}
	close(code: number | null = 0, signal: string | null = null) {
		if (this.closed) return;
		this.closed = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}
}

let root: string;
let children: Child[];
let input: PassThrough;
const hostProcess = process;
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	root = mkdtempSync(join(tmpdir(), "leafcode-runner-contract-"));
	vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
	children = [];
	boundary.control = undefined;
	boundary.spawn.mockImplementation(() => {
		const child = new Child();
		children.push(child);
		return child;
	});
	input = new PassThrough();
	const processEvents = new EventEmitter();
	// Each CLI invocation normally owns a process, including its signal listeners.
	// Drive stdin without exporting private functions or retaining host listeners.
	vi.stubGlobal("process", new Proxy(hostProcess, {
		get(target, key) {
			if (key === "argv") return [hostProcess.execPath, "subagent-runner.ts"];
			if (key === "stdin") return input;
			if (key === "on" || key === "once" || key === "off") return processEvents[key].bind(processEvents);
			return Reflect.get(target, key);
		},
	}));
});
afterEach(async () => {
	for (const child of children) child.close(1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	input.destroy();
	rmSync(root, { recursive: true, force: true });
});

const step = { agent: "worker", task: "Summarize", completionGuard: false };
function status(): AsyncStatus {
	return JSON.parse(readFileSync(join(root, "run", "status.json"), "utf8"));
}
async function start(overrides: Record<string, unknown> = {}, initialStates = ["running", "pending"]) {
	await import("./subagent-runner.ts");
	input.end(JSON.stringify({ id: "contract-run", sessionId: "contract-session", cwd: root, asyncDir: join(root, "run"),
		resultPath: join(root, "result.json"), placeholder: "{previous}",
		steps: [step, { ...step, agent: "next" }], ...overrides }));
	await vi.waitFor(() => expect(children).toHaveLength(initialStates.filter((value) => value === "running").length));
	expect(status().state).toBe("running");
	expect(status().steps.map((item) => item.status)).toEqual(initialStates);
}
async function result() {
	await vi.waitFor(() => expect(boundary.dispose).toHaveBeenCalledOnce());
	return JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
}

describe("background runner lifecycle characterization", () => {
	it("runs sequential children and persists matching complete status/result", async () => {
		await start();
		children[0].message();
		children[0].close();
		await vi.waitFor(() => expect(children).toHaveLength(2));
		expect(status().steps[0].status).toBe("complete");
		children[1].message("second");
		children[1].close();
		const completed = await result();
		expect(status().state).toBe("complete");
		expect(status().steps.map((item) => item.status)).toEqual(["complete", "complete"]);
		expect(completed).toMatchObject({ state: "complete", success: true, exitCode: 0 });
	});

	it.each([
		["stop", "stopped", "stopped", 1],
		["timeout", "failed", "failed", 1],
		["interrupt", "paused", "paused", 0],
	] as const)("%s prevents the next child and preserves its distinct terminal state", async (action, state, childStatus, exitCode) => {
		await start();
		children[0].message("partial", 0, "toolUse");
		const control = boundary.control!;
		if (action === "stop") control.onStop();
		else if (action === "timeout") control.onTimeout();
		else control.onInterrupt();
		const completed = await result();
		expect(children).toHaveLength(1);
		expect(children[0].kill).toHaveBeenCalled();
		expect(status().state).toBe(state);
		expect(status().steps[0].status).toBe(childStatus);
		expect(completed).toMatchObject({ state, exitCode, success: false });
		if (action === "stop") expect(completed.stopped).toBe(true);
		if (action === "timeout") expect(completed.timedOut).toBe(true);
		if (action === "interrupt") expect(status().steps[1].status).toBe("pending");
	});

	it.each(["stop", "interrupt"] as const)("a later timeout cannot overwrite %s", async (first) => {
		await start();
		children[0].message("partial", 0, "toolUse");
		if (first === "stop") boundary.control!.onStop();
		else boundary.control!.onInterrupt();
		boundary.control!.onTimeout();
		await result();
		expect(status().state).toBe(first === "stop" ? "stopped" : "paused");
		expect(status().timedOut).not.toBe(true);
	});

	it("fires the parent deadline without an external timeout request", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await start({ timeoutMs: 1000, deadlineAt: Date.now() + 1000 });
		await vi.advanceTimersByTimeAsync(status().deadlineAt! - Date.now() - 1);
		expect(children[0].kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		const completed = await result();
		expect(completed).toMatchObject({ state: "failed", timedOut: true, exitCode: 1 });
		expect(status().error).toBe("Subagent timed out after 1000ms.");
	});

	it("uses a shorter step deadline and cancels its timer after completion", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await start({ steps: [{ ...step, timeoutMs: 100 }, step], timeoutMs: 1000, deadlineAt: Date.now() + 1000 });
		await vi.advanceTimersByTimeAsync(100);
		await result();
		expect(status().state).toBe("failed");
		expect(status().steps[0]).toMatchObject({ timedOut: true, error: "Subagent timed out after 100ms." });
		expect(children).toHaveLength(1);
		const calls = children[0].kill.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(children[0].kill).toHaveBeenCalledTimes(calls);
	});

	it.each(["stop", "timeout", "interrupt"] as const)("%s reaches every active parallel child", async (action) => {
		await start({ steps: [{ parallel: [step, { ...step, agent: "sibling" }] }] }, ["running", "running"]);
		for (const child of children) child.message("partial", 0, "toolUse");
		if (action === "stop") boundary.control!.onStop();
		else if (action === "timeout") boundary.control!.onTimeout();
		else boundary.control!.onInterrupt();
		const completed = await result();
		const terminal = action === "stop" ? "stopped" : action === "timeout" ? "failed" : "paused";
		expect(completed.state).toBe(terminal);
		expect(status().steps.map((item) => item.status)).toEqual([terminal, terminal]);
		for (const child of children) expect(child.kill).toHaveBeenCalled();
	});

	it("cancels parent and step timers after successful completion", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await start({ steps: [{ ...step, timeoutMs: 500 }], timeoutMs: 1000, deadlineAt: Date.now() + 1000 }, ["running"]);
		children[0].message();
		children[0].close();
		await result();
		await vi.advanceTimersByTimeAsync(2000);
		expect(status().state).toBe("complete");
		expect(children[0].kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("enforces the turn limit at a non-terminal assistant boundary", async () => {
		await start({ turnBudget: { maxTurns: 1, graceTurns: 0 } });
		children[0].message("partial", 0, "toolUse");
		const completed = await result();
		expect(children).toHaveLength(1);
		expect(completed).toMatchObject({ state: "failed", turnBudgetExceeded: true, exitCode: 1 });
		expect(status().turnBudget).toMatchObject({ outcome: "exceeded", turnCount: 1 });
	});

	it("does not launch the next step once the cumulative token budget is exhausted", async () => {
		await start({ usageBudget: { tokens: { hard: 10 } } });
		children[0].message("within first step", 10);
		children[0].close();
		const completed = await result();
		expect(children).toHaveLength(1);
		expect(status().state).toBe("failed");
		expect(status().usageBudget).toMatchObject({ exhausted: true });
		expect(completed).toMatchObject({ state: "failed", success: false, exitCode: 1 });
	});
});
