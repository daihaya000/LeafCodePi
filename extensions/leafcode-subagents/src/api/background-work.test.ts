import { afterEach, describe, expect, it } from "vitest";
import { captureSessionBackgroundWorkStop, registerBackgroundWorkProvider, stopSessionBackgroundWork } from "./background-work";

describe("stopSessionBackgroundWork", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it("runs a captured stop after its provider is unregistered, once", async () => {
    const stopped: { id: string; sessionId: string }[] = [];
    unregister = registerBackgroundWorkProvider({
      name: "test-captured-stop",
      listActiveWork: () => [{ id: "owned", sessionId: "session-a" }],
      captureStopWork: (item) => () => { stopped.push(item); },
    });
    const stopCaptured = captureSessionBackgroundWorkStop("session-a");
    unregister();
    unregister = undefined;

    await expect(stopCaptured()).resolves.toBe(1);
    await expect(stopCaptured()).resolves.toBe(0);
    expect(stopped).toEqual([{ id: "owned", sessionId: "session-a" }]);
  });

  it("stops only provider items owned by the requested session", async () => {
    const stopped: { id: string; sessionId: string }[] = [];
    unregister = registerBackgroundWorkProvider({
      name: "test-session-stop",
      listActiveWork: () => [
        { id: "owned-a", sessionId: "session-a" },
        { id: "owned-b", sessionId: "session-b" },
      ],
      stopWork: (item) => { stopped.push(item); },
    });

    await expect(stopSessionBackgroundWork("session-a")).resolves.toBe(1);
    expect(stopped).toEqual([{ id: "owned-a", sessionId: "session-a" }]);
  });
});
