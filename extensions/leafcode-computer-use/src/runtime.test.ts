import { describe, expect, it } from "vitest";
import { ActiveSessionRegistry, SessionResourceScheduler, SessionStateMap, StateStore } from "./runtime.ts";

describe("ActiveSessionRegistry", () => {
	it("allows shared shutdown only after the final session releases", () => {
		const sessions = new ActiveSessionRegistry();
		sessions.register("session-a");
		sessions.register("session-b");

		expect(sessions.release("session-a")).toBe(false);
		expect(sessions.release("session-b")).toBe(true);
		expect(sessions.release("session-b")).toBe(false);
		expect(sessions.release("unknown")).toBe(false);
	});
});

describe("SessionStateMap", () => {
	it("creates and clears state by exact session id", () => {
		const states = new SessionStateMap<Map<string, string>>();
		states.getOrCreate("session-a", () => new Map()).set("ref", "a");
		states.getOrCreate("session-b", () => new Map()).set("ref", "b");

		states.clearSession("session-a");

		expect(states.get("session-a")).toBeUndefined();
		expect(states.get("session-b")?.get("ref")).toBe("b");
	});
});

describe("SessionResourceScheduler", () => {
	it("keeps resource epochs and shutdown isolated by session", async () => {
		let activeSessionId = "session-a";
		const scheduler = new SessionResourceScheduler(() => activeSessionId);

		await scheduler.write("desktop:1", 0, async (epoch) => epoch);
		activeSessionId = "session-b";
		await scheduler.write("desktop:1", 0, async (epoch) => epoch);
		expect(scheduler.epoch("desktop:1")).toBe(1);

		await scheduler.closeSession("session-a");
		activeSessionId = "session-a";
		await expect(scheduler.read("desktop:1", async () => "unreachable")).rejects.toThrow("shutting down");

		activeSessionId = "session-b";
		await scheduler.write("desktop:1", 1, async (epoch) => epoch);
		expect(scheduler.epoch("desktop:1")).toBe(2);
	});
});

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
