import { describe, expect, it } from "vitest";
import { SavedStates, type UiObservation } from "./state.ts";

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
});
