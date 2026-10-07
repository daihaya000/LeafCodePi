import { createHash } from "node:crypto";
import { registerBackgroundWorkProvider, type BackgroundWorkItem, type BackgroundWorkProvider } from "../../api/background-work.ts";
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
	// Preserve existing short provider names used by persisted wait subscriptions.
	const name = `subagents:${sessionId}`;
	return {
		// Session identity can be a long Windows path. Keep only the registry name bounded.
		name: name.length <= 128 ? name : `subagents:sha256:${createHash("sha256").update(sessionId).digest("hex")}`,
		listActiveWork: () => [...state.asyncJobs.values()]
			.filter((job) => job.sessionId === sessionId && isActive(job.status))
			.map((job) => ({ id: job.asyncId, sessionId })),
		stopWork: (item: BackgroundWorkItem) => stopItem(state, item, sessionId, stopRun),
		captureStopWork: (item: BackgroundWorkItem) => {
			if (item.sessionId !== sessionId || state.currentSessionId !== sessionId) return undefined;
			const job = state.asyncJobs.get(item.id);
			if (!job || job.sessionId !== sessionId || !isActive(job.status)) return undefined;
			if (job.mode === "workflow") {
				return () => { throw new Error(`Workflow run '${item.id}' cannot be stopped by this provider.`); };
			}
			// Runtime cleanup clears the live map; retain only this validated run and its owner.
			const capturedState = { ...state, currentSessionId: sessionId, asyncJobs: new Map([[job.asyncId, { ...job }]]) } as SubagentState;
			return () => stopItem(capturedState, item, sessionId, stopRun);
		},
	};
}

function stopItem(state: SubagentState, item: BackgroundWorkItem, sessionId: string, stopRun: StopAsyncRun): void {
	if (item.sessionId !== sessionId || state.currentSessionId !== sessionId) return;
	const job = state.asyncJobs.get(item.id);
	if (!job || job.sessionId !== sessionId || !isActive(job.status)) return;
	if (job.mode === "workflow") throw new Error(`Workflow run '${item.id}' cannot be stopped by this provider.`);
	const result = stopRun(state, item.id);
	if (result?.isError) throw new Error(`Failed to stop subagent run '${item.id}'.`);
}

export function registerSubagentBackgroundWorkProvider(
	state: SubagentState,
	sessionId: string,
	stopRun: StopAsyncRun = stopAsyncRun,
): () => void {
	return registerBackgroundWorkProvider(createSubagentBackgroundWorkProvider(state, sessionId, stopRun));
}
