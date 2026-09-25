// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ labels: [] as unknown[] }));

vi.mock("@/lib/session-label-settings", () => ({
  findSessionLabel: (_labels: unknown, id: string | null | undefined) =>
    id ? { id, name: "A label that is too wide", hint: "", color: "red" } : undefined,
  hydrateSessionLabelsFromServer: () => Promise.resolve(),
  readSessionLabels: () => mocks.labels,
  subscribeSessionLabels: () => () => undefined,
}));

import { SessionLabelBadge } from "./SessionLabelBadge";

afterEach(() => {
  mocks.labels = [];
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

  it("shows a gray placeholder for unlabelled sessions only while labels exist", () => {
    const empty = render(<SessionLabelBadge labelId={null} />);
    expect(empty.container.textContent).toBe("");
    empty.unmount();

    mocks.labels = [{ id: "code", name: "\u30b3\u30fc\u30c9", hint: "", color: "blue" }];
    const { container } = render(<SessionLabelBadge labelId={null} />);
    expect(container.querySelector("[data-placeholder]")?.textContent).toBe("-");
  });
});
