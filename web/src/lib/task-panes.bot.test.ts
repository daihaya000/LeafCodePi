import { describe, expect, it } from "vitest";
import {
  createState,
  isBotOwnedTaskId,
  isBotSurfaceTabId,
  isBotTabId,
  isSplitHostPath,
  normalize,
  paneTabIdForTask,
  paneTabIdsForWorkingTasks,
  retargetActiveTab,
  tabIdFromPathname,
  taskIdsToAutoClose,
  taskPanesReducer,
} from "./task-panes";

describe("Bot tabs share Code panes", () => {
  it.each(["/bots", "/bots/one", "/bots/rooms/one", "/bots/a%20b"])("recognizes %s", (path) => {
    expect(isSplitHostPath(path)).toBe(true);
    expect(tabIdFromPathname(path)).toBe(path);
  });
  it("applies the pane preference to Bot tabs without mixing delegated Code tasks", () => {
    expect(isBotTabId("bot:one")).toBe(false);
    const state = retargetActiveTab(createState("bot:one"), "/bots/one");
    expect(state.panes.map((pane) => pane.tabs)).toEqual([["bot:one"], ["/bots/one"]]);
    const legacy = retargetActiveTab(createState("bot:one"), "/bots/one", { preferNewPane: false });
    expect(legacy.panes[0].tabs).toEqual(["bot:one", "/bots/one"]);
    const split = taskPanesReducer(legacy, { type: "openInNewPane", taskId: "/bots/one", anchorPaneId: legacy.panes[0].id, direction: "bottom" });
    expect(split.panes).toHaveLength(2);
    expect(normalize(JSON.parse(JSON.stringify(split)))).toEqual(split);
    expect(taskIdsToAutoClose({ openTaskIds: ["/bots", "/bots/one", "/bots/rooms/one", "missing"], existingIds: new Set(), activeIds: new Set(), previouslyActiveIds: new Set() })).toEqual(["missing"]);
  });
});

describe("paneTabIdForTask keeps Bot-owned work on BotView", () => {
  it("maps Bot conversation and Room-member tasks to Bot/Room routes", () => {
    expect(paneTabIdForTask({ id: "bot:one", kind: "bot", botId: "one" })).toBe("/bots/one");
    expect(paneTabIdForTask({ id: "bot:one:room:room-1", kind: "bot", botId: "one" })).toBe("/bots/rooms/room-1");
    expect(paneTabIdForTask({ id: "bot:one" })).toBe("/bots/one");
    expect(isBotTabId("bot:one")).toBe(false);
    expect(isBotOwnedTaskId("bot:one")).toBe(true);
    expect(isBotSurfaceTabId("bot:one")).toBe(true);
    expect(isBotSurfaceTabId("/bots/one")).toBe(true);
  });

  it("maps Bot-owned Code sessions to the owning BotView and leaves plain Code tasks alone", () => {
    expect(paneTabIdForTask({ id: "code-linked", kind: "code", botId: "one" })).toBe("/bots/one");
    expect(paneTabIdForTask({ id: "plain-code", kind: "code" })).toBe("plain-code");
  });

  it("collapses a Bot task and its Code session onto one Bot tab", () => {
    expect(paneTabIdsForWorkingTasks([
      { id: "code-linked", kind: "code", botId: "one" },
      { id: "bot:one", kind: "bot", botId: "one" },
      { id: "plain-code", kind: "code" },
    ])).toEqual(["/bots/one", "plain-code"]);
  });

  it("showWorkingTasks rewrites stored bot: ids onto BotView tabs", () => {
    const next = taskPanesReducer(createState("old"), {
      type: "showWorkingTasks",
      taskIds: ["bot:one", "plain-code", "bot:one"],
    });
    expect(next.panes.map((pane) => pane.tabs)).toEqual([["/bots/one"], ["plain-code"]]);
  });
});
