import { isUnexplainedProcessSignal } from "./process-signal.ts";
import type { SubagentResultStatus } from "../../shared/types.ts";

export interface SubagentResultStatusInput {
	exitCode?: number | null;
	success?: boolean;
	state?: string;
	interrupted?: boolean;
	detached?: boolean;
	processSignal?: string | null;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudgetExceeded?: boolean;
	usageBudgetExceeded?: boolean;
}

/** Resolve one child result to the status used by foreground and async projections. */
export function resolveSubagentResultStatus(input: SubagentResultStatusInput): SubagentResultStatus {
	if (input.detached) return "detached";
	if (input.stopped || input.state === "stopped") return "stopped";
	if (input.interrupted || input.state === "paused") return "paused";
	if (input.timedOut || input.turnBudgetExceeded || input.usageBudgetExceeded) return "failed";
	if (input.success === true) return "completed";
	if (isUnexplainedProcessSignal(input) && input.exitCode !== 0) return "stopped";
	if (input.success === false) return "failed";
	if (input.state === "complete") return "completed";
	if (input.state === "failed") return "failed";
	if (typeof input.exitCode === "number") return input.exitCode === 0 ? "completed" : "failed";
	return "failed";
}

export type AsyncStepStatus = "complete" | "failed" | "paused" | "stopped";

export interface AsyncStepOutcomeInput {
	parentStopped?: boolean;
	parentTimedOut?: boolean;
	exitCode?: number | null;
	interrupted?: boolean;
	stopped?: boolean;
	timedOut?: boolean;
	turnBudgetExceeded?: boolean;
	usageBudgetExceeded?: boolean;
}

export interface AsyncStepOutcome {
	status: AsyncStepStatus;
	exitCode: number | null | undefined;
	event: "completed" | "failed" | "paused" | "stopped";
}

/**
 * Project a child result into the async status/event vocabulary. Parent stop
 * wins over timeout, which wins over child interrupt, matching runner control
 * precedence.
 */
export function resolveAsyncStepOutcome(input: AsyncStepOutcomeInput): AsyncStepOutcome {
	const status = input.parentStopped || input.stopped
		? "stopped"
		: input.parentTimedOut
			? "failed"
			: resolveSubagentResultStatus({
					exitCode: input.exitCode,
					interrupted: input.interrupted,
					stopped: input.stopped,
					timedOut: input.timedOut,
					turnBudgetExceeded: input.turnBudgetExceeded,
					usageBudgetExceeded: input.usageBudgetExceeded,
				});
	if (status === "stopped") return { status, exitCode: 1, event: "stopped" };
	if (status === "paused") return { status, exitCode: 0, event: "paused" };
	if (status === "completed") return { status: "complete", exitCode: input.exitCode, event: "completed" };
	return { status: "failed", exitCode: input.parentTimedOut || input.timedOut || input.turnBudgetExceeded || input.usageBudgetExceeded ? 1 : input.exitCode, event: "failed" };
}
