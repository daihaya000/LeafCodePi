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

  it("uses role icons and falls back to Bot for custom agents", () => {
    const view = render(<AgentSelect value="plan" agents={["plan", "custom-agent"]} onChange={() => {}} />);

    expect(screen.getByRole("button", { name: "エージェント" }).querySelector('[data-agent-icon="plan"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));
    expect(screen.getByRole("option", { name: "plan" }).querySelector('[data-agent-icon="plan"]')).not.toBeNull();
    expect(screen.getByRole("option", { name: "custom-agent" }).querySelector('[data-agent-icon="custom-agent"]')).not.toBeNull();

    view.rerender(<AgentSelect value="custom-agent" agents={["plan", "custom-agent"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "エージェント" }).querySelector('[data-agent-icon="custom-agent"]')).not.toBeNull();
  });
});
