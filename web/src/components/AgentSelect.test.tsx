// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSelect } from "./AgentSelect";

describe("AgentSelect", () => {
  afterEach(cleanup);

  it("does not show the placeholder as a selectable agent", () => {
    render(<AgentSelect value="build" agents={["build", "programmer"]} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "build",
      "programmer",
    ]);
    expect(screen.queryByRole("option", { name: "エージェント" })).toBeNull();
  });

  it("uses build instead of an empty or placeholder value", () => {
    const view = render(<AgentSelect value="" agents={["build", "programmer"]} onChange={() => {}} />);

    const button = screen.getByRole("button", { name: "エージェント" });
    expect(button.textContent).toContain("build");
    fireEvent.click(button);
    expect(screen.queryByRole("option", { name: "エージェント" })).toBeNull();

    view.rerender(<AgentSelect value="エージェント" agents={["build", "programmer"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "エージェント" }).textContent).toContain("build");
  });
});
