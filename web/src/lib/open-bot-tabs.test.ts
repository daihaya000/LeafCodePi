import { afterEach, describe, expect, it } from "vitest";
import { getOpenBotTabIds, isBotTabOpen, setOpenBotTabIds, subscribeOpenBotTabs } from "./open-bot-tabs";
import { isRoutineRunShownInline } from "./notify";

afterEach(() => setOpenBotTabIds([]));

describe("open Bot tabs", () => {
  it("reports a Bot opened in any pane, not only the active one", () => {
    setOpenBotTabIds(["bot-1", "bot-2"]);
    expect(getOpenBotTabIds()).toEqual(new Set(["bot-1", "bot-2"]));
    expect(isBotTabOpen("bot-1")).toBe(true);
    expect(isBotTabOpen("bot-3")).toBe(false);
  });

  it("suppresses the routine notification for a Bot open in a background pane", () => {
    setOpenBotTabIds(["bot-1"]);
    // The active pane shows a task, not the Bot, yet BotView renders the inline card.
    expect(isRoutineRunShownInline("/task/other", "bot-1")).toBe(true);
    expect(isRoutineRunShownInline("/task/other", "bot-2")).toBe(false);
    // The active-pane path still works without any published tabs.
    setOpenBotTabIds([]);
    expect(isRoutineRunShownInline("/bots/bot-1", "bot-1")).toBe(true);
  });

  it("notifies subscribers only when the set actually changes", () => {
    let notifications = 0;
    const unsubscribe = subscribeOpenBotTabs(() => { notifications += 1; });
    setOpenBotTabIds(["a"]);
    setOpenBotTabIds(["a"]);
    setOpenBotTabIds(["a", "b"]);
    expect(notifications).toBe(2);
    unsubscribe();
  });
});
