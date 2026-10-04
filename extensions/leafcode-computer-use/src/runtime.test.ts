import { describe, expect, it } from "vitest";
import { StateStore } from "./runtime.ts";

describe("StateStore.clearSession", () => {
	it("clears only records owned by the requested session", () => {
		const store = new StateStore<string>();
		store.set({ stateId: "a1", ownerSessionId: "session-a", resourceKey: "desktop:1", epoch: 1, value: "a" });
		store.set({ stateId: "b1", ownerSessionId: "session-b", resourceKey: "desktop:1", epoch: 2, value: "b" });
		store.set({ stateId: "legacy", resourceKey: "desktop:1", epoch: 0, value: "legacy" });

		store.clearSession("session-a");

		expect(store.get("a1")).toBeUndefined();
		expect(store.get("b1")?.value).toBe("b");
		expect(store.get("legacy")?.value).toBe("legacy");
		expect(store.size).toBe(2);
	});
});
