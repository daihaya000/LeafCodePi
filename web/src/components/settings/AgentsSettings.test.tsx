// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/lib/types";
import { AgentsSettings } from "./AgentsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));
vi.mock("@/components/ModelSelect", () => ({
  ModelSelect: ({
    value,
    options,
    disabled,
    onChange,
    ariaLabel,
  }: {
    value: string;
    options: ModelOption[];
    disabled?: boolean;
    onChange: (value: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const agents = [
  {
    id: "disabled",
    name: "disabled",
    enabled: false,
    source: "package" as const,
    filePath: "C:/disabled.md",
  },
  {
    id: "enabled",
    name: "enabled",
    enabled: true,
    model: "openai-codex/gpt-5.6-luna",
    source: "package" as const,
    filePath: "C:/enabled.md",
  },
];

const models: ModelOption[] = [
  {
    value: "openai-codex::gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    providerID: "openai-codex",
    modelID: "gpt-5.6-luna",
  },
  {
    value: "anthropic::claude",
    label: "Claude",
    providerID: "anthropic",
    modelID: "claude",
  },
];

describe("AgentsSettings", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) =>
      path === "/api/agents"
        ? Promise.resolve({ agents, agentsDir: "C:/pi/agent/agents" })
        : path === "/api/settings/auto-agent-prompt"
          ? Promise.resolve({ value: "レビューでは reviewer を優先" })
          : Promise.resolve({ models }),
    );
    sendJson.mockResolvedValue({ agents });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("prioritizes enabled agents and saves a selected model", async () => {
    render(<AgentsSettings />);

    await screen.findByRole("switch", { name: "enabled を無効化" });
    expect(screen.getByText("enabled").parentElement?.querySelector('[data-agent-icon="enabled"]')).not.toBeNull();
    expect(screen.getByText("disabled").parentElement?.querySelector('[data-agent-icon="disabled"]')).not.toBeNull();
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual([
      "enabled",
      "disabled",
    ]);

    const model = screen.getByRole("combobox", { name: "enabled のモデル" }) as HTMLSelectElement;
    expect(model.value).toBe("openai-codex::gpt-5.6-luna");
    fireEvent.change(model, { target: { value: "anthropic::claude" } });

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { model: "anthropic/claude" },
        "PATCH",
      );
    });
  });

  it("saves subagent effort independently from the Composer setting", async () => {
    render(<AgentsSettings />);

    const effort = await screen.findByRole("button", { name: "enabled のEffort" });
    expect(effort.textContent).toContain("既定");
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "high" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/agents/enabled",
        { thinking: "high" },
        "PATCH",
      );
    });
  });

  it("shows every subagent without an internal scroll container", async () => {
    render(<AgentsSettings />);

    const agentSwitch = await screen.findByRole("switch", { name: "enabled を無効化" });
    const list = agentSwitch.closest("ul");
    expect(list?.className).not.toContain("max-h-");
    expect(list?.className).not.toContain("overflow-y-auto");
    expect(screen.getAllByRole("listitem")).toHaveLength(agents.length);
  });

  it("loads and saves the Auto agent selector prompt", async () => {
    render(<AgentsSettings />);

    const prompt = await screen.findByRole("textbox", { name: "モデル選定者向けプロンプト" }) as HTMLTextAreaElement;
    expect(prompt.value).toBe("レビューでは reviewer を優先");

    fireEvent.change(prompt, { target: { value: "レビューは reviewer を優先" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/auto-agent-prompt",
        { value: "レビューは reviewer を優先" },
        "PUT",
      );
    });
  });
});
