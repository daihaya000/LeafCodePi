// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("scales the whole badge only when constrained and restores it on resize", () => {
    let resize = () => {};
    let availableWidth = 40;
    let naturalWidth = 80;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe(target: HTMLElement) {
        Object.defineProperty(target, "clientWidth", { configurable: true, get: () => availableWidth });
        Object.defineProperty(target, "offsetWidth", { configurable: true, get: () => naturalWidth });
        resize();
      }
      disconnect = disconnect;
    });

    const view = render(<StatusBadge status="working" />);
    const badge = screen.getByText("実行中").parentElement!;
    const container = badge.parentElement!;
    expect(container.className).toContain("min-w-0");
    expect(badge.style.transform).toBe("scale(0.5)");

    resize();
    expect(badge.style.transform).toBe("scale(0.5)");

    availableWidth = 60;
    resize();
    expect(badge.style.transform).toBe("scale(0.75)");

    availableWidth = 100;
    resize();
    expect(badge.style.transform).toBe("");

    naturalWidth = 120;
    view.rerender(<StatusBadge status="archived" />);
    expect(badge.style.transform).toBe(`scale(${100 / 120})`);
    expect(screen.getByText("アーカイブ済")).toBeTruthy();

    availableWidth = 0;
    resize();
    expect(badge.style.transform).toBe("scale(0)");
    availableWidth = 60;
    resize();
    expect(badge.style.transform).toBe("scale(0.5)");
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("keeps the normal badge when layout measurements are unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<StatusBadge status="working" />);
    expect(screen.getByText("実行中").parentElement!.style.transform).toBe("");
  });

  it("labels an idle worktree as clean", () => {
    render(<StatusBadge status="idle" />);
    expect(screen.getByText("クリーン")).toBeTruthy();
  });

  it("labels a changed worktree as changed", () => {
    render(<StatusBadge status="ready" />);
    expect(screen.getByText("変更あり")).toBeTruthy();
  });
});
