// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeSharedElapsedClock, Switch } from "./ui";

let restoreVisibilityState: (() => void) | undefined;
function setVisibilityState(state: "visible" | "hidden"): void {
  if (!restoreVisibilityState) {
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    restoreVisibilityState = () => {
      if (original) Object.defineProperty(document, "visibilityState", original);
      else Reflect.deleteProperty(document, "visibilityState");
      restoreVisibilityState = undefined;
    };
  }
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restoreVisibilityState?.();
});

describe("Switch", () => {

  it("exposes switch semantics and a 44px touch target with a fixed-size track", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="テスト項目を有効化" />);

    const toggle = screen.getByRole("switch", { name: "テスト項目を有効化" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.className).toContain("h-11");
    expect(toggle.className).toContain("w-11");
    expect(toggle.className).toContain("sm:h-6");

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("pauses shared elapsed updates while hidden and refreshes immediately when visible", () => {
    vi.useFakeTimers();
    setVisibilityState("visible");
    const listener = vi.fn();
    const unsubscribe = subscribeSharedElapsedClock(listener);

    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    setVisibilityState("hidden");
    vi.advanceTimersByTime(5_000);
    expect(listener).toHaveBeenCalledTimes(1);

    setVisibilityState("visible");
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("shows the ON state with the success token and disables interaction while busy", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Switch checked={true} onChange={onChange} label="テスト項目を無効化" busy />,
    );

    const toggle = screen.getByRole("switch", { name: "テスト項目を無効化" }) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(true);

    rerender(<Switch checked={true} onChange={onChange} label="テスト項目を無効化" />);
    const track = toggle.querySelector("span");
    expect(track?.className).toContain("bg-success");
  });
});
