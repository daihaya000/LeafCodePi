// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session-label-settings", () => ({
  findSessionLabel: (_labels: unknown, id: string | null | undefined) =>
    id ? { id, name: "A label that is too wide", hint: "", color: "red" } : undefined,
  hydrateSessionLabelsFromServer: () => Promise.resolve(),
  readSessionLabels: () => [],
  subscribeSessionLabels: () => () => undefined,
}));

import { SessionLabelBadge } from "./SessionLabelBadge";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SessionLabelBadge", () => {
  it("shrinks the font to fit the available badge width", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        Object.defineProperty(target, "clientWidth", { configurable: true, value: 40 });
        const text = target.querySelector("span")!;
        Object.defineProperty(text, "getBoundingClientRect", {
          configurable: true,
          value: () => ({ width: 80 }) as DOMRect,
        });
        this.callback([], this as unknown as ResizeObserver);
      }
      disconnect() {}
    });

    const { container } = render(<SessionLabelBadge labelId="long" />);
    expect((container.querySelector("span > span") as HTMLElement).style.fontSize).toBe("4.5px");
  });
});
