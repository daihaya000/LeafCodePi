import { describe, expect, it } from "vitest";
import { SavedStates, terminalDesktopActionResourceKey, type UiObservation } from "./state.ts";

describe("SavedStates.clearSession", () => {
	it("preserves another session's observations", () => {
		const savedStates = new SavedStates();
		const record = (stateId: string, ownerSessionId: string) => ({
			stateId,
			ownerSessionId,
			resourceKey: "desktop-pid:1",
			epoch: 1,
			value: {} as UiObservation,
		});
		savedStates.set(record("a", "session-a"));
		savedStates.set(record("b", "session-b"));

		savedStates.clearSession("session-a");

		expect(savedStates.get("a")).toBeUndefined();
		expect(savedStates.get("b")?.ownerSessionId).toBe("session-b");
	});

	it("deletes a terminal state's stale observation", () => {
		const savedStates = new SavedStates();
		savedStates.set({ stateId: "stale", ownerSessionId: "session-a", resourceKey: "desktop-pid:1", epoch: 1, value: {} as UiObservation });

		expect(savedStates.delete("stale")).toBe(true);
		expect(savedStates.get("stale")).toBeUndefined();
	});
});

describe("terminalDesktopActionResourceKey", () => {
	it("invalidates desktop roots only after terminal act results", () => {
		expect(terminalDesktopActionResourceKey({ tool: "act_ui", status: "target_closed", target: { pid: 42 } })).toBe("desktop-pid:42");
		expect(terminalDesktopActionResourceKey({ tool: "act_ui", status: "post_action_observation_failed", target: { pid: 42 } })).toBe("desktop-pid:42");
		expect(terminalDesktopActionResourceKey({ tool: "act_ui", status: "ok", target: { pid: 42 } })).toBeUndefined();
		expect(terminalDesktopActionResourceKey({ tool: "observe_ui", status: "target_closed", target: { pid: 42 } })).toBeUndefined();
		expect(terminalDesktopActionResourceKey({ tool: "act_ui", status: "target_closed", target: { pid: 0 } })).toBeUndefined();
		expect(terminalDesktopActionResourceKey({ tool: "act_ui", status: "target_closed", target: { pid: 42.5 } })).toBeUndefined();
	});
});
