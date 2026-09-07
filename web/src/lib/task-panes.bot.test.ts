import { describe, expect, it } from "vitest";
import { createState, isBotTabId, isSplitHostPath, normalize, retargetActiveTab, tabIdFromPathname, taskIdsToAutoClose, taskPanesReducer } from "./task-panes";

describe("Bot tabs share Code panes", () => {
  it.each(["/bots", "/bots/one", "/bots/rooms/one", "/bots/a%20b"])("recognizes %s", (path) => {
    expect(isSplitHostPath(path)).toBe(true);
    expect(tabIdFromPathname(path)).toBe(path);
  });
  it("keeps Bot tabs separate from delegated Code tasks", () => {
    expect(isBotTabId("bot:one")).toBe(false);
    const state = retargetActiveTab(createState("bot:one"), "/bots/one");
    expect(state.panes[0].tabs).toEqual(["bot:one", "/bots/one"]);
    const split = taskPanesReducer(state, { type: "openInNewPane", taskId: "/bots/one", anchorPaneId: state.panes[0].id, direction: "bottom" });
    expect(split.panes).toHaveLength(2);
    expect(normalize(JSON.parse(JSON.stringify(split)))).toEqual(split);
    expect(taskIdsToAutoClose({ openTaskIds: ["/bots", "/bots/one", "/bots/rooms/one", "missing"], existingIds: new Set(), activeIds: new Set(), previouslyActiveIds: new Set() })).toEqual(["missing"]);
  });
});
