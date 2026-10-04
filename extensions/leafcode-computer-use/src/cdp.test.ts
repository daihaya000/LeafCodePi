import { describe, expect, it } from "vitest";
import { CdpSessionConnectionRegistry } from "./cdp.ts";

describe("CdpSessionConnectionRegistry", () => {
	it("disconnects only the requested session and invalidates pending connections", () => {
		const registry = new CdpSessionConnectionRegistry<{ close(): void }>();
		let closedA = false;
		let closedB = false;
		const stateA = registry.forSession("session-a");
		const stateB = registry.forSession("session-b");
		stateA.connectedTabs.set("tab", { close: () => { closedA = true; } });
		registry.setPort("session-a", "9222");
		registry.setPort("session-b", undefined);
		expect(registry.portFor("session-a", "9000")).toBe("9222");
		expect(registry.portFor("session-b", "9000")).toBe("9000");
		stateA.connectingTabs.set("pending", Promise.resolve({ close: () => { closedA = true; } }));
		stateB.connectedTabs.set("tab", { close: () => { closedB = true; } });

		registry.disconnect("session-a");

		expect(closedA).toBe(true);
		expect(closedB).toBe(false);
		expect(stateA.generation).toBe(1);
		expect(stateA.connectingTabs.size).toBe(0);
		expect(registry.portFor("session-a", "9000")).toBe("9000");
		expect(registry.forSession("session-b")).toBe(stateB);
		expect(stateB.connectedTabs.size).toBe(1);
	});
});
