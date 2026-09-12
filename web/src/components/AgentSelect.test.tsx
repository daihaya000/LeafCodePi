// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelect } from "./AgentSelect";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";

describe("AgentSelect", () => {
  afterEach(cleanup);

  it("does not show the placeholder as a selectable agent", () => {
    render(<AgentSelect value="builder" agents={["builder", "programmer"]} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Auto",
      "builder",
      "programmer",
    ]);
    expect(screen.queryByRole("option", { name: "エージェント" })).toBeNull();
  });

  it("uses builder instead of an empty or placeholder value", () => {
    const view = render(<AgentSelect value="" agents={["builder", "programmer"]} onChange={() => {}} />);

    const button = screen.getByRole("button", { name: "エージェント" });
    expect(button.textContent).toContain("builder");
    fireEvent.click(button);
    expect(screen.queryByRole("option", { name: "エージェント" })).toBeNull();

    view.rerender(<AgentSelect value="エージェント" agents={["builder", "programmer"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "エージェント" }).textContent).toContain("builder");
  });

  it("reports Auto and uses role icons for real agents", () => {
    const onChange = vi.fn();
    render(<AgentSelect value={AUTO_AGENT_VALUE} agents={["builder", "programmer"]} onChange={onChange} />);

    const button = screen.getByRole("button", { name: "エージェント" });
    expect(button.textContent).toContain("Auto");
    expect(button.querySelector(`[data-agent-icon="${AUTO_AGENT_VALUE}"]`)).not.toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("option", { name: "Auto" }));
    expect(onChange).toHaveBeenCalledWith(AUTO_AGENT_VALUE);
  });

  it("uses role icons and falls back to Bot for custom agents", () => {
    const view = render(<AgentSelect value="planner" agents={["planner", "custom-agent"]} onChange={() => {}} />);

    expect(screen.getByRole("button", { name: "エージェント" }).querySelector('[data-agent-icon="planner"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));
    expect(screen.getByRole("option", { name: "planner" }).querySelector('[data-agent-icon="planner"]')).not.toBeNull();
    expect(screen.getByRole("option", { name: "custom-agent" }).querySelector('[data-agent-icon="custom-agent"]')).not.toBeNull();

    view.rerender(<AgentSelect value="custom-agent" agents={["planner", "custom-agent"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "エージェント" }).querySelector('[data-agent-icon="custom-agent"]')).not.toBeNull();
  });

  it("supports keyboard navigation and selection", () => {
    const onChange = vi.fn();
    render(
      <>
        <AgentSelect
          value="builder"
          agents={["builder", "programmer", "reviewer"]}
          onChange={onChange}
        />
        <button type="button">次の操作</button>
      </>,
    );

    const trigger = screen.getByRole("button", { name: "エージェント" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "builder" }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "programmer" }));
    fireEvent.keyDown(document.activeElement!, { key: " " });

    expect(onChange).toHaveBeenCalledWith("programmer");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "次の操作" }));
  });

  it("shows each agent's tool permissions on dropdown options", () => {
    render(
      <AgentSelect
        value="builder"
        agents={[{ name: "builder", tools: ["read", "grep"] }, { name: "custom-agent" }]}
        onChange={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "エージェント" }));

    expect(screen.getByRole("option", { name: "builder" }).getAttribute("title")).toBe(
      "ツール権限: read, grep",
    );
    expect(screen.getByRole("option", { name: "custom-agent" }).getAttribute("title")).toBe(
      "ツール権限: 既定",
    );
  });
});
