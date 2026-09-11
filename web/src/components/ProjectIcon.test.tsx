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
});
