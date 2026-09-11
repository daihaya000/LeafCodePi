// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectIcon } from "./ProjectIcon";

describe("ProjectIcon", () => {
  it("falls back to the project initial when the saved icon fails to load", () => {
    const { container, rerender } = render(<ProjectIcon project={{ id: "project-a", name: "Project A", icon: "/missing-icon.png" }} />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("P")).toBeTruthy();

    rerender(<ProjectIcon project={{ id: "project-a", name: "Project A", icon: "/new-icon.png" }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/new-icon.png");
  });

  it.each([
    ["", "?"],
    ["   ", "?"],
    ["日本語", "日"],
    ["ßeta", "S"],
  ])("renders one safe initial for the project name %j", (name, initial) => {
    const { container } = render(<ProjectIcon project={{ id: `project-${name || "empty"}`, name, icon: null }} />);

    expect(container.querySelector("span")?.textContent).toBe(initial);
  });
});
