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
  it("4ペイン追加時は2x2グリッドへ切り替える", () => {
    expect(paneLayoutClass(state(3))).toContain("flex");
    expect(paneLayoutClass(state(4))).toContain("grid-cols-2 grid-rows-2");
  });

  it("4ペインでもドロップ方向のflexレイアウトを優先する", () => {
    expect(paneLayoutClass(state(4, "row"))).toContain("flex");
    expect(paneLayoutClass(state(4, "row"))).not.toContain("grid");
    expect(paneLayoutClass(state(4, "column"))).toContain("flex-col");
    expect(paneLayoutClass(state(4, "column"))).not.toContain("grid");
  });

  it("4ペインで方向がない旧保存値は2x2グリッドを維持する", () => {
    expect(paneLayoutClass(state(4))).toContain("grid-cols-2 grid-rows-2");
  });
});
