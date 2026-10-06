import { describe, expect, it, vi } from "vitest";
import { CdpSessionConnectionRegistry, CdpTab, chooseVisibleCdpCandidate } from "./cdp.ts";

describe("chooseVisibleCdpCandidate", () => {
	it("chooses only the unique visible tab in the matching window", () => {
		expect(chooseVisibleCdpCandidate([
			{ value: "background", frameMatches: true, visibility: "hidden" },
			{ value: "active", frameMatches: true, visibility: "visible" },
			{ value: "other-window", frameMatches: false, visibility: "visible" },
		], true)).toBe("active");
	});

	it("does not select an arbitrary tab when visibility is ambiguous", () => {
		expect(chooseVisibleCdpCandidate([
			{ value: "first", frameMatches: true, visibility: "hidden" },
			{ value: "second", frameMatches: true, visibility: "hidden" },
		], true)).toBeUndefined();
		expect(chooseVisibleCdpCandidate([
			{ value: "first", frameMatches: true, visibility: "visible" },
			{ value: "second", frameMatches: true, visibility: "visible" },
		], false)).toBeUndefined();
	});
});

class FakeWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static lastInstance?: FakeWebSocket;
	readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
	readyState = FakeWebSocket.OPEN;
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: () => void;
	onerror?: () => void;

	constructor(_url: string) {
		FakeWebSocket.lastInstance = this;
		queueMicrotask(() => this.onopen?.());
	}

	send(raw: string): void {
		const request = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
		this.requests.push(request);
		queueMicrotask(() => {
			const result = request.method === "DOM.resolveNode" ? { object: { objectId: "object-1" } } : {};
			this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
			if (request.method === "Page.navigate") this.onmessage?.({ data: JSON.stringify({ method: "Page.loadEventFired" }) });
		});
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

describe("CdpTab.navigate", () => {
	it("clears its load timeout when navigation completes", async () => {
		vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let tab: CdpTab | undefined;
		try {
			tab = await CdpTab.connect("ws://127.0.0.1:9222/devtools/page/test", "test", "title");
			await tab.navigate("https://example.com");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			tab?.close();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});
});

describe("CdpTab text input", () => {
	async function openTab(): Promise<CdpTab> {
		vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
		return await CdpTab.connect("ws://127.0.0.1:9222/devtools/page/test", "test", "title");
	}

	it("uses CDP text insertion after focusing a backend node", async () => {
		let tab: CdpTab | undefined;
		try {
			tab = await openTab();
			await tab.typeIntoBackendNode(7, "hello", false);

			const requests = FakeWebSocket.lastInstance!.requests;
			const focusCall = requests.find((request) => request.method === "Runtime.callFunctionOn")!;
			expect(focusCall.params.functionDeclaration).toContain("this.focus()");
			expect(focusCall.params.functionDeclaration).not.toContain("this.value =");
			expect(requests.find((request) => request.method === "Input.insertText")?.params).toEqual({ text: "hello" });
		} finally {
			tab?.close();
			vi.unstubAllGlobals();
		}
	});

	it("selects before replacement and clears selected text for an empty value", async () => {
		let tab: CdpTab | undefined;
		try {
			tab = await openTab();
			await tab.typeIntoBackendNode(7, "replacement", true);
			const requests = FakeWebSocket.lastInstance!.requests;
			const selectAll = requests.find((request) => request.method === "Input.dispatchKeyEvent")!;
			expect(selectAll.params).toMatchObject({ type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
			expect(requests.find((request) => request.method === "Input.insertText")?.params).toEqual({ text: "replacement" });

			requests.length = 0;
			await tab.typeIntoBackendNode(7, "", true);
			const emptyReplacement = requests.filter((request) => request.method === "Input.dispatchKeyEvent");
			expect(emptyReplacement.map((request) => request.params.key)).toEqual(["a", "a", "Backspace", "Backspace"]);
			expect(requests.some((request) => request.method === "Input.insertText")).toBe(false);
		} finally {
			tab?.close();
			vi.unstubAllGlobals();
		}
	});
});

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
