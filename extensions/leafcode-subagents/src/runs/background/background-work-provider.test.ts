import { describe, expect, it } from "vitest";
import { snapshotBackgroundWork } from "../../api/background-work.ts";
import type { AsyncJobState, SubagentState } from "../../shared/types.ts";
import { createSubagentBackgroundWorkProvider, registerSubagentBackgroundWorkProvider } from "./background-work-provider.ts";

function stateFor(sessionId: string, jobs: AsyncJobState[]) {
	return {
		currentSessionId: sessionId,
		asyncJobs: new Map(jobs.map((job) => [job.asyncId, job])),
	} as unknown as SubagentState;
}

describe("createSubagentBackgroundWorkProvider", () => {
	it("lists all active runs owned by its session", () => {
		const provider = createSubagentBackgroundWorkProvider(stateFor("session-a", [
			{ asyncId: "owned-running", asyncDir: "a", sessionId: "session-a", status: "running", mode: "single" },
			{ asyncId: "owned-queued", asyncDir: "b", sessionId: "session-a", status: "queued", mode: "single" },
			{ asyncId: "other", asyncDir: "c", sessionId: "session-b", status: "running", mode: "single" },
			{ asyncId: "workflow", asyncDir: "d", sessionId: "session-a", status: "running", mode: "workflow" },
			{ asyncId: "finished", asyncDir: "e", sessionId: "session-a", status: "complete", mode: "single" },
		]), "session-a");

		expect(provider.listActiveWork()).toEqual([
			{ id: "owned-running", sessionId: "session-a" },
			{ id: "owned-queued", sessionId: "session-a" },
			{ id: "workflow", sessionId: "session-a" },
		]);
	});

	it("registers a session-scoped provider and its disposer removes it", () => {
		const state = stateFor("session-a", [
			{ asyncId: "owned", asyncDir: "a", sessionId: "session-a", status: "running", mode: "single" },
		]);
		const unregister = registerSubagentBackgroundWorkProvider(state, "session-a");
		try {
			expect(snapshotBackgroundWork("session-a").items).toEqual([
				{ provider: "subagents:session-a", id: "owned", sessionId: "session-a" },
			]);
			expect(snapshotBackgroundWork("session-b").items).toEqual([]);
		} finally {
			unregister();
		}
		expect(snapshotBackgroundWork("session-a").items).toEqual([]);
	});

	it("fails closed when asked to stop another session's run or after ownership changes", () => {
		const state = stateFor("session-a", [
			{ asyncId: "owned", asyncDir: "a", sessionId: "session-a", status: "running", mode: "single" },
			{ asyncId: "other", asyncDir: "b", sessionId: "session-b", status: "running", mode: "single" },
			{ asyncId: "workflow", asyncDir: "c", sessionId: "session-a", status: "running", mode: "workflow" },
		]);
		const stopped: string[] = [];
		const provider = createSubagentBackgroundWorkProvider(state, "session-a", (_state, id) => { stopped.push(id); return null; });

		provider.stopWork?.({ id: "owned", sessionId: "session-a" });
		expect(stopped).toEqual(["owned"]);
		provider.stopWork?.({ id: "other", sessionId: "session-b" });
		expect(() => provider.stopWork?.({ id: "workflow", sessionId: "session-a" })).toThrow(/cannot be stopped/);
		state.currentSessionId = "session-b";
		provider.stopWork?.({ id: "owned", sessionId: "session-a" });
		expect(stopped).toEqual(["owned"]);
	});
});
