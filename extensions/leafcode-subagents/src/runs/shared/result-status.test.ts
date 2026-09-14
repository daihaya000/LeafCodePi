import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveAsyncStepOutcome, resolveSubagentResultStatus } from "./result-status.ts";

describe("resolveSubagentResultStatus", () => {
	it("projects successful and failed exit codes", () => {
		assert.equal(resolveSubagentResultStatus({ exitCode: 0 }), "completed");
		assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
		assert.equal(resolveSubagentResultStatus({ success: false, exitCode: 0 }), "failed");
	});

	it("keeps explicit terminal control states ahead of success", () => {
		assert.equal(resolveSubagentResultStatus({ stopped: true, success: true }), "stopped");
		assert.equal(resolveSubagentResultStatus({ interrupted: true, success: true }), "paused");
		assert.equal(resolveSubagentResultStatus({ detached: true, stopped: true }), "detached");
	});

	it("does not turn a timed-out or budget-exhausted child into completed", () => {
		assert.equal(resolveSubagentResultStatus({ timedOut: true, success: true, exitCode: 0 }), "failed");
		assert.equal(resolveSubagentResultStatus({ turnBudgetExceeded: true, success: true, exitCode: 0 }), "failed");
		assert.equal(resolveSubagentResultStatus({ usageBudgetExceeded: true, success: true, exitCode: 0 }), "failed");
	});

	it("recognizes unexplained process termination as stopped", () => {
		assert.equal(resolveSubagentResultStatus({ processSignal: "SIGTERM", exitCode: 1 }), "stopped");
		assert.equal(resolveSubagentResultStatus({ processSignal: "SIGTERM", timedOut: true, exitCode: 1 }), "failed");
	});
});

describe("resolveAsyncStepOutcome", () => {
	it("preserves the runner precedence and event vocabulary", () => {
		assert.deepEqual(resolveAsyncStepOutcome({ parentStopped: true, parentTimedOut: true, interrupted: true, exitCode: 0 }), {
			status: "stopped", exitCode: 1, event: "stopped",
		});
		assert.deepEqual(resolveAsyncStepOutcome({ parentTimedOut: true, interrupted: true, exitCode: 0 }), {
			status: "failed", exitCode: 1, event: "failed",
		});
		assert.deepEqual(resolveAsyncStepOutcome({ interrupted: true, exitCode: 1 }), {
			status: "paused", exitCode: 0, event: "paused",
		});
		assert.deepEqual(resolveAsyncStepOutcome({ exitCode: 0 }), {
			status: "complete", exitCode: 0, event: "completed",
		});
	});
});
