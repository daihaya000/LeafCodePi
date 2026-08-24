// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodoProgressPanel } from "./TodoProgressPanel";
import type { TodoDto } from "@/lib/types";

const todos = (statuses: TodoDto["status"][]): TodoDto[] =>
  statuses.map((status, index) => ({
    id: String(index),
    content: `作業${index + 1}`,
    status,
    priority: "medium",
  }));

describe("TodoProgressPanel progress color", () => {
  afterEach(() => cleanup());

  it("uses blue until every item is complete, then switches to green", () => {
    const { rerender } = render(<TodoProgressPanel todos={todos(["completed", "in_progress"])} />);
    const progress = screen.getByRole("progressbar", { name: "ToDo完了率" });

    expect(progress.firstElementChild?.classList.contains("bg-working")).toBe(true);
    expect(screen.getByText("50%").classList.contains("text-working")).toBe(true);

    rerender(<TodoProgressPanel todos={todos(["completed", "cancelled"])} />);
    expect(progress.firstElementChild?.classList.contains("bg-success")).toBe(true);
    expect(screen.getByText("100%").classList.contains("text-success")).toBe(true);
  });
});
