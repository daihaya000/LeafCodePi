import { describe, expect, it } from "vitest";
import type { TaskPanesState } from "@/lib/task-panes";
import { paneLayoutClass } from "./TaskTabs";

function state(paneCount: number, orientation?: TaskPanesState["orientation"]): TaskPanesState {
  return {
    panes: Array.from({ length: paneCount }, (_, index) => ({
      id: `pane-${index}`,
      tabs: [],
      activeTabId: null,
    })),
    activePaneId: "pane-0",
    orientation,
  };
}

describe("paneLayoutClass", () => {
  it("レイアウトツリーの親として常にflexコンテナを返す", () => {
    expect(paneLayoutClass(state(1))).toContain("flex");
    expect(paneLayoutClass(state(4))).toContain("flex");
    expect(paneLayoutClass(state(4))).not.toContain("grid");
    expect(paneLayoutClass(state(4, "column"))).not.toContain("flex-col");
  });
});
