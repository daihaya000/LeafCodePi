// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoUpdateActivity } from "./AutoUpdateActivity";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("reports real input, coalesces bursts, and does not heartbeat an idle tab", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AutoUpdateActivity />);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  act(() => { window.dispatchEvent(new Event("pointermove")); window.dispatchEvent(new Event("keydown")); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(600_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  cleanup();
  act(() => window.dispatchEvent(new Event("pointerdown")));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("retries failed delivery and reports visible/focus activity without background polling", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AutoUpdateActivity />);
  expect(fetchMock).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
