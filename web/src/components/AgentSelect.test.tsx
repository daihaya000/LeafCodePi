// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelect } from "./AgentSelect";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";

describe("AgentSelect", () => {
  afterEach(cleanup);

  it("does not show the placeholder as a selectable agent", () => {
    render(<AgentSelect value="build" agents={["build", "programmer"]} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Auto",
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

  it("reports Auto and uses role icons for real agents", () => {
    const onChange = vi.fn();
    render(<AgentSelect value={AUTO_AGENT_VALUE} agents={["build", "programmer"]} onChange={onChange} />);

    const button = screen.getByRole("button", { name: "エージェント" });
    expect(button.textContent).toContain("Auto");
    expect(button.querySelector(`[data-agent-icon="${AUTO_AGENT_VALUE}"]`)).not.toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("option", { name: "Auto" }));
    expect(onChange).toHaveBeenCalledWith(AUTO_AGENT_VALUE);
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

  it("shows each agent's tool permissions on dropdown options", () => {
    render(
      <AgentSelect
        value="build"
        agents={[{ name: "build", tools: ["read", "grep"] }, { name: "custom-agent" }]}
        onChange={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));

    expect(screen.getByRole("option", { name: "build" }).getAttribute("title")).toBe(
      "ツール権限: read, grep",
    );
    expect(screen.getByRole("option", { name: "custom-agent" }).getAttribute("title")).toBe(
      "ツール権限: 既定",
    );
  });
});
