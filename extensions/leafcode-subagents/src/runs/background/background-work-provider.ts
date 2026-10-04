import type { BackgroundWorkItem, BackgroundWorkProvider } from "../../api/background-work.ts";
import { stopAsyncRun } from "../foreground/async-stop-action.ts";
import type { SubagentState } from "../../shared/types.ts";

type StopAsyncRun = typeof stopAsyncRun;

const isActive = (status: string) => status === "queued" || status === "running";

/** Exposes only stoppable async runs owned by one parent session. */
export function createSubagentBackgroundWorkProvider(
	state: SubagentState,
	sessionId: string,
	stopRun: StopAsyncRun = stopAsyncRun,
): BackgroundWorkProvider {
	return {
		name: `subagents:${sessionId}`,
		listActiveWork: () => [...state.asyncJobs.values()]
			.filter((job) => job.sessionId === sessionId && isActive(job.status))
			.map((job) => ({ id: job.asyncId, sessionId })),
		stopWork: (item: BackgroundWorkItem) => {
			if (item.sessionId !== sessionId || state.currentSessionId !== sessionId) return;
			const job = state.asyncJobs.get(item.id);
			if (!job || job.sessionId !== sessionId || !isActive(job.status)) return;
			if (job.mode === "workflow") throw new Error(`Workflow run '${item.id}' cannot be stopped by this provider.`);
			const result = stopRun(state, item.id);
			if (result?.isError) throw new Error(`Failed to stop subagent run '${item.id}'.`);
		},
	};
}
