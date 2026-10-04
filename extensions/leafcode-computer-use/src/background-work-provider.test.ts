import { afterEach, describe, expect, it } from "vitest";
import { captureSessionBackgroundWorkStop, snapshotBackgroundWork } from "../../leafcode-subagents/src/api/background-work.ts";
import { registerComputerUseShutdownResource } from "./background-work-provider.ts";

let unregister = () => {};
afterEach(() => unregister());

describe("computer-use shutdown resource provider", () => {
	it("captures cleanup only for its session without reporting active work", async () => {
		let shutdowns = 0;
		unregister = registerComputerUseShutdownResource("session-a", async () => { shutdowns += 1; });

		expect(snapshotBackgroundWork("session-a").items).toEqual([]);
		expect(await captureSessionBackgroundWorkStop("session-b")()).toBe(0);
		const stop = captureSessionBackgroundWorkStop("session-a");
		expect(await stop()).toBe(1);
		expect(await stop()).toBe(0);
		expect(shutdowns).toBe(1);
	});
});
