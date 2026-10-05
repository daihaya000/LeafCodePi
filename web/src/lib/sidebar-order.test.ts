import { describe, expect, it } from "vitest";
import { orderPaneTabIdsForSidebar, projectsForSidebar } from "./sidebar-order";
import type { TaskSummary } from "./types";

const task = (id: string, projectId: string | null, status = "working", updatedAt = "2026-01-01") =>
  ({ id, projectId, status, updatedAt } as TaskSummary);

describe("sidebar pane ordering", () => {
  it("ignores stale/duplicate project IDs and appends new projects", () => {
    expect(projectsForSidebar([{ id: "a" }, { id: "b" }, { id: "c" }], ["b", "gone", "b", "a"]))
      .toEqual([{ id: "b" }, { id: "a" }, { id: "c" }]);
  });

  it("orders projectless, custom project groups and pinned/working/updated rows before filtering targets", () => {
    const tasks = [
      task("a-new", "a", "working", "2026-01-05"),
      task("b-old", "b"), task("b-new", "b", "working", "2026-01-02"),
      task("b-pinned", "b", "ready"), task("b-unread", "b", "ready", "2026-01-06"),
      task("no-project", null), task("read", "b", "ready"),
    ];
    expect(orderPaneTabIdsForSidebar(
      ["a-new", "b-old", "b-new", "no-project", "b-unread", "b-pinned"], tasks,
      [{ id: "a" }, { id: "b" }], ["b", "a"], new Set(["b-pinned"]),
    )).toEqual(["no-project", "b-pinned", "b-new", "b-old", "b-unread", "a-new"]);
  });

  it("keeps Bot aliases, unknown targets and archived project tasks without duplication or loss", () => {
    const botTask = { ...task("bot:one", "a"), kind: "bot", botId: "one" } as TaskSummary;
    expect(orderPaneTabIdsForSidebar(
      ["/bots/one", "archived", "unknown", "active", "/bots/one"],
      [botTask, task("archived", "old"), task("active", "a")],
      [{ id: "old", archived: true }, { id: "a" }], ["old", "a"],
    )).toEqual(["active", "archived", "/bots/one", "unknown"]);
  });
});
