import { describe, expect, it } from "vitest";
import {
  normalizeTaskPanelState,
  toggleTaskPanel,
  type TaskPanelState,
} from "./mobile-panel-state";

const closed: TaskPanelState = { graphOpen: false, diffOpen: false };

describe("mobile task panels", () => {
  it("allows only one panel on mobile", () => {
    expect(toggleTaskPanel({ ...closed, diffOpen: true }, "graph", false)).toEqual({
      graphOpen: true,
      diffOpen: false,
    });
    expect(toggleTaskPanel({ ...closed, graphOpen: true }, "diff", false)).toEqual({
      graphOpen: false,
      diffOpen: true,
    });
  });

  it("keeps both panels available above the mobile breakpoint", () => {
    expect(toggleTaskPanel({ ...closed, graphOpen: true }, "diff", true)).toEqual({
      graphOpen: true,
      diffOpen: true,
    });
  });

  it("normalizes a desktop state when resized to mobile", () => {
    expect(normalizeTaskPanelState({ graphOpen: true, diffOpen: true }, false)).toEqual({
      graphOpen: true,
      diffOpen: false,
    });
  });
});
