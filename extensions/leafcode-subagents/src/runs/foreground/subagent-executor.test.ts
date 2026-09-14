import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import type { SubagentParamsLike } from "./subagent-executor.ts";

const launch = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn() }));
vi.mock("./execution.ts", () => ({ runSync: launch.sync }));
vi.mock("../background/async-execution.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../background/async-execution.ts")>(),
	executeAsyncSingle: launch.async,
}));

let root: string;
let state: SubagentState;
let executorApi: typeof import("./subagent-executor.ts");
let executor: ReturnType<typeof executorApi.createSubagentExecutor>;
let ctx: Parameters<typeof executor.execute>[4];
let discover: ReturnType<typeof vi.fn>;
const childResult = { agent: "worker", task: "Summarize", exitCode: 0, messages: [], finalOutput: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	root = mkdtempSync(join(tmpdir(), "leafcode-executor-contract-"));
	vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
	executorApi = await import("./subagent-executor.ts");
	state = {
		baseCwd: root, currentSessionId: "parent", asyncJobs: new Map(),
		foregroundControls: new Map(), foregroundRuns: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
		watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
	};
	discover = vi.fn(() => ({ agents: [{ name: "worker", description: "Test worker", systemPrompt: "Summarize", source: "project" as const, filePath: join(root, "worker.md") }] }));
	ctx = {
		cwd: root, hasUI: false, model: { provider: "test", id: "parent-model" },
		sessionManager: { getSessionId: () => "parent", getSessionFile: () => null, getLeafId: () => null },
		modelRegistry: { getAvailable: () => [] },
	} as unknown as typeof ctx;
	executor = executorApi.createSubagentExecutor({
		pi: { getSessionName: () => "parent", getThinkingLevel: () => "off", events: { emit() {}, on: () => () => {} } } as never,
		state, config: { intercomBridge: { mode: "off" } }, asyncByDefault: false,
		tempArtifactsDir: join(root, "artifacts"), getSubagentSessionRoot: () => root,
		expandTilde: (value) => value, discoverAgents: discover,
		kill: () => { throw new Error("No real process should be signalled"); },
	});
	launch.sync.mockResolvedValue(childResult);
	launch.async.mockImplementation((id: string) => ({ content: [], details: { mode: "single", asyncId: id, results: [] } }));
});
afterEach(() => {
	for (const timer of state?.cleanupTimers.values() ?? []) clearTimeout(timer);
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});
function execute(params: SubagentParamsLike, signal = new AbortController().signal) {
	return executor.execute("tool-call", params, signal, undefined, ctx);
}
function text(result: Awaited<ReturnType<typeof execute>>) {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function foreground() {
	const control: ForegroundRunControl = { runId: "foreground-run", mode: "single", sessionId: "parent", startedAt: 1, updatedAt: 1, currentAgent: "worker", currentIndex: 0, currentActivityState: "needs_attention", interrupt: vi.fn(() => true) };
	state.foregroundControls.set(control.runId, control);
	state.lastForegroundControlId = control.runId;
	return control;
}

describe("executor timeout contract", () => {
	it.each([false, true])("uses the single-child backstop for async=%s, but honors explicit aliases", (async) => {
		expect(executorApi.resolveSingleAgentLaunchTimeout({}, async)).toEqual({ timeoutMs: 1_800_000 });
		expect(executorApi.resolveSingleAgentLaunchTimeout({}, async, 500)).toEqual({ timeoutMs: 500 });
		expect(executorApi.resolveSingleAgentLaunchTimeout({ maxRuntimeMs: 100 }, async, 500)).toEqual({ timeoutMs: 100 });
		expect(executorApi.resolveSingleAgentLaunchTimeout({ timeoutMs: 100, maxRuntimeMs: 100 }, async)).toEqual({ timeoutMs: 100 });
	});
	it("leaves an async composite unbounded even with a configured default", () => {
		for (const params of [{ workflowScript: "return 1" }, { tasks: [{ agent: "worker", task: "Summarize" }] }, { chain: [{ agent: "worker", task: "Summarize" }] }]) {
			expect(executorApi.resolveSingleAgentLaunchTimeout(params, true, 500)).toEqual({});
			expect(executorApi.resolveSingleAgentLaunchTimeout(params, false, 500)).toEqual({ timeoutMs: 500 });
		}
	});
	it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid explicit timeout %s", (timeoutMs) => {
		expect(executorApi.resolveForegroundTimeout({ timeoutMs }).error).toMatch(/positive integer/);
	});
	it("rejects conflicting aliases and ignores invalid configuration defaults", () => {
		expect(executorApi.resolveForegroundTimeout({ timeoutMs: 100, maxRuntimeMs: 200 }).error).toMatch(/aliases/);
		expect(executorApi.resolveConfigDefaultTimeoutMs(2_147_483_647)).toBe(2_147_483_647);
		for (const value of [0, -1, 1.5, NaN, Infinity, "100", 2_147_483_648]) expect(executorApi.resolveConfigDefaultTimeoutMs(value)).toBeUndefined();
	});
});

describe("executor lifecycle boundary", () => {
	it("distinguishes stop from foreground interrupt and keeps status observational", async () => {
		const control = foreground();
		const stopped = await execute({ action: "stop", id: control.runId });
		expect(stopped.isError).toBe(true);
		expect(text(stopped)).toContain("Use action='interrupt'");
		expect(control.interrupt).not.toHaveBeenCalled();
		const inspected = await execute({ action: "status", id: control.runId });
		expect(text(inspected)).toContain("State: running");
		expect(control.updatedAt).toBe(1);
		const interrupted = await execute({ action: "interrupt", id: control.runId });
		expect(interrupted.isError).not.toBe(true);
		expect(control.interrupt).toHaveBeenCalledOnce();
		expect(control.updatedAt).toBeGreaterThan(1);
		expect(control.currentActivityState).toBeUndefined();
		expect(state.foregroundControls.has(control.runId)).toBe(true);
	});

	it("reports an interrupt with no active child as an error without changing status", async () => {
		const control = foreground();
		control.interrupt = vi.fn(() => false);
		const interrupted = await execute({ action: "interrupt", id: control.runId });
		expect(interrupted.isError).toBe(true);
		expect(text(interrupted)).toContain("no active child step");
		expect(control.updatedAt).toBe(1);
	});

	it("stops an owned async workflow through its controller", async () => {
		const controller = new AbortController();
		state.workflowControllers = new Map([["workflow-run", controller]]);
		const stopped = await execute({ action: "stop", id: "workflow-run" });
		expect(stopped.isError).not.toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(controller.signal.reason.message).toBe("Workflow stopped by user.");
		expect(launch.sync).not.toHaveBeenCalled();
	});

	it.each([
		[{ toolBudget: { hard: 0 } }, /toolBudget/],
		[{ usageBudget: { tokens: { soft: 20, hard: 10 } } }, /soft.*less than or equal/],
	] as const)("rejects invalid budget %j before launch", async (budget, error) => {
		const result = await execute({ agent: "worker", task: "Summarize", ...budget });
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(error);
		expect(discover).not.toHaveBeenCalled();
		expect(launch.sync).not.toHaveBeenCalled();
		expect(launch.async).not.toHaveBeenCalled();
	});

	it("passes deadline, cancellation and budgets to the child, then removes live control", async () => {
		const controller = new AbortController();
		const before = Date.now();
		const result = await execute({ agent: "worker", task: "Summarize", context: "fresh", artifacts: false,
			timeoutMs: 500, toolBudget: { hard: 2 }, turnBudget: { maxTurns: 3 }, usageBudget: { tokens: { hard: 10 } } }, controller.signal);
		expect(result.isError, text(result)).not.toBe(true);
		expect(launch.sync).toHaveBeenCalledOnce();
		const options = launch.sync.mock.calls[0][4];
		expect(options).toMatchObject({ timeoutMs: 500, signal: controller.signal, toolBudget: { hard: 2 }, turnBudget: { maxTurns: 3 } });
		expect(options.deadlineAt).toBeGreaterThanOrEqual(before + 500);
		expect(options.deadlineAt).toBeLessThanOrEqual(Date.now() + 500);
		expect(state.foregroundControls.size).toBe(0);
		expect(state.subagentInProgress).toBe(false);
		expect(state.foregroundRuns!.size).toBe(1);
		expect(result.details.usageBudget).toMatchObject({ exhausted: false });
	});

	it("interrupts the active child without aborting its parent or admitting a duplicate foreground call", async () => {
		let settle!: (value: typeof childResult & { interrupted: boolean }) => void;
		launch.sync.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
		const parent = new AbortController();
		const request = { agent: "worker", task: "Summarize", context: "fresh" as const, artifacts: false };
		const running = execute(request, parent.signal);
		try {
			await vi.waitFor(() => expect(launch.sync).toHaveBeenCalledOnce());
			const runId = state.lastForegroundControlId!;
			const duplicate = await execute(request);
			expect(duplicate.isError).toBe(true);
			expect(launch.sync).toHaveBeenCalledOnce();
			const interruption = await execute({ action: "interrupt", id: runId });
			expect(interruption.isError).not.toBe(true);
			expect(launch.sync.mock.calls[0][4].interruptSignal.aborted).toBe(true);
			expect(parent.signal.aborted).toBe(false);
			expect(state.foregroundControls.has(runId)).toBe(true);
		} finally {
			settle({ ...childResult, interrupted: true });
			await running;
		}
		expect(state.foregroundControls.size).toBe(0);
		expect(state.subagentInProgress).toBe(false);
		expect([...state.foregroundRuns!.values()][0].children[0].status).toBe("paused");
	});

	it("releases the dispatch guard and child control after a launch rejection", async () => {
		launch.sync.mockRejectedValueOnce(new Error("test launch failure"));
		const request = { agent: "worker", task: "Summarize", context: "fresh" as const, artifacts: false };
		const failed = await execute(request);
		expect(failed.isError).toBe(true);
		expect(text(failed)).toContain("test launch failure");
		expect(state.foregroundControls.size).toBe(0);
		expect(state.subagentInProgress).toBe(false);
		const retry = await execute(request);
		expect(retry.isError, text(retry)).not.toBe(true);
		expect(launch.sync).toHaveBeenCalledTimes(2);
	});

	it.each(["completed", "failed", "paused"] as const)("revives a remembered %s child with its existing session/model and a new run id", async (status) => {
		const sessionFile = join(root, "child.jsonl");
		writeFileSync(sessionFile, "", "utf8");
		state.foregroundRuns!.set("old-run", { runId: "old-run", mode: "single", cwd: root, sessionId: "parent", updatedAt: 1,
			children: [{ index: 0, agent: "worker", status, sessionFile, model: "test/persisted" }] });
		const result = await execute({ action: "resume", id: "old-run", message: "Continue", timeoutMs: 250, toolBudget: { hard: 2 } });
		expect(result.isError, text(result)).not.toBe(true);
		expect(launch.async).toHaveBeenCalledOnce();
		const [id, options] = launch.async.mock.calls[0];
		expect(id).not.toBe("old-run");
		expect(options).toMatchObject({ sessionFile, modelOverride: "test/persisted", timeoutMs: 250, toolBudget: { hard: 2 }, revivalLease: { sessionFile, sourceRunId: "old-run", runId: id } });
		expect(state.foregroundRuns!.get("old-run")!.children[0].status).toBe(status);
	});

	it("rejects resume model overrides before launching or discovering agents", async () => {
		const result = await execute({ action: "resume", id: "old-run", message: "Continue", model: "other/model" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("reuses the persisted child model");
		expect(discover).not.toHaveBeenCalled();
		expect(launch.async).not.toHaveBeenCalled();
	});
});
