// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskActivityIcon, TaskProgressBar } from "./Sidebar";

describe("TaskProgressBar", () => {
  afterEach(() => cleanup());

  it("overrides ToDo progress while a Goal Loop is running", () => {
    render(
      <TaskProgressBar
        task={{
          title: "タスクA",
          todoProgress: { completed: 1, total: 2 },
          goalLoopSummary: { status: "running", maxTurns: 10, turnCount: 4 },
        }}
      />,
    );

    const progress = screen.getByRole("progressbar", { name: "タスクAのループ進捗" });
    expect(progress.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.queryByRole("progressbar", { name: "タスクAのToDo進捗" })).toBeNull();
  });

  it("shows the active Bot avatar for a Bot-originated working task", () => {
    const { container } = render(
      <TaskActivityIcon
        task={{ status: "working", botId: "bot-1" }}
        bot={{ name: "Builder", avatarColor: "#0071E3", avatarImage: null }}
      />,
    );

    expect(container.querySelector(".bot-avatar-working")).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("Builderのアバター");
  });
});
