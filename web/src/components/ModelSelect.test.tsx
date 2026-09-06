// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/lib/types";
import {
  ModelSelect,
  modelLimitReached,
  modelNearLimit,
  modelOptionForValue,
} from "./ModelSelect";

function option(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    value: "anthropic::claude",
    label: "Claude",
    providerID: "anthropic",
    modelID: "claude",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("modelNearLimit", () => {
  it("is false below 75%", () => {
    expect(modelNearLimit(option({ codexbarUsedPercent: 74 }))).toBe(false);
  });

  it("is true at 75% when not maxed", () => {
    expect(modelNearLimit(option({ codexbarUsedPercent: 75, codexbarMaxed: false }))).toBe(true);
  });

  it("is false when maxed (handled separately)", () => {
    expect(modelNearLimit(option({ codexbarUsedPercent: 100, codexbarMaxed: true }))).toBe(false);
  });
});

describe("modelLimitReached", () => {
  it("is true when codexbarMaxed is set", () => {
    expect(modelLimitReached(option({ codexbarMaxed: true }))).toBe(true);
  });

  it("is false when usage unknown", () => {
    expect(modelLimitReached(option())).toBe(false);
  });
});

describe("modelOptionForValue", () => {
  it("maps an old account-prefixed value to an integrated option only", () => {
    const integrated = option({
      value: "anthropic::claude",
      routingMode: "integrated",
    });
    expect(modelOptionForValue([integrated], "acc-1::anthropic::claude")).toBe(integrated);
    expect(modelOptionForValue([option({ value: "acc-2::anthropic::claude", accountId: "acc-2" })], "anthropic::claude")).toBeUndefined();
  });
});

describe("ModelSelect loading state", () => {
  it("does not show modelなし while models are loading", () => {
    render(<ModelSelect value="" options={[]} loading onChange={() => {}} />);

    expect(screen.getByText("モデルを読み込み中…")).toBeTruthy();
  });

  it("does not allow selecting the Auto placeholder before models load", () => {
    render(
      <ModelSelect
        value=""
        options={[option({ value: "auto", label: "Auto" })]}
        loading
        onChange={() => {}}
      />,
    );

    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("モデルを読み込み中…")).toBeTruthy();
  });

  it("shows modelなし only when there are no available models", () => {
    render(<ModelSelect value="" options={[]} onChange={() => {}} />);

    expect(screen.getByText("モデルなし")).toBeTruthy();
  });

  it("keeps the generic model placeholder when a selection is missing", () => {
    render(<ModelSelect value="missing" options={[option()]} onChange={() => {}} />);

    expect(screen.getByText("モデル")).toBeTruthy();
  });
});

describe("ModelSelect grouping by account", () => {
  it("splits providers into per-account groups and keeps shared providers plain", () => {
    render(
      <ModelSelect
        value="acc-1::openai-codex::gpt-5"
        options={[
          option({
            value: "llama-server::local",
            label: "Local",
            providerID: "llama-server",
            modelID: "local",
          }),
          option({
            value: "acc-1::openai-codex::gpt-5",
            label: "GPT-5",
            providerID: "openai-codex",
            modelID: "gpt-5",
            accountId: "acc-1",
            accountLabel: "仕事用",
          }),
        ]}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    const listbox = screen.getByRole("listbox");
    expect(listbox.className).toContain("100dvh");
    expect(listbox.parentElement?.className).toContain("100vw");
    expect(screen.getByText("llama-server")).toBeTruthy();
    const accountGroup = screen.getByText("Codex · 仕事用");
    expect(accountGroup.className).toContain("truncate");
  });

  it("supports arrow, Home/End, Enter, and Escape keyboard operation", () => {
    const onChange = vi.fn();
    render(
      <>
        <ModelSelect
          value="ollama-cloud::llama-3"
          options={[
            option({ value: "ollama-cloud::llama-3", label: "Llama 3", modelID: "llama-3" }),
            option({ value: "openai::gpt-5", label: "GPT-5", providerID: "openai", modelID: "gpt-5" }),
            option({ value: "custom::model", label: "Custom", providerID: "custom", modelID: "model" }),
          ]}
          onChange={onChange}
        />
        <button type="button">次の操作</button>
      </>,
    );

    const trigger = screen.getByRole("button", { name: "モデル" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const options = screen.getAllByRole("option");
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0]!, { key: "End" });
    expect(document.activeElement).toBe(options.at(-1));
    fireEvent.keyDown(options.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(options.at(-1));
    fireEvent.keyDown(options.at(-1)!, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("custom::model");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "次の操作" }));
  });

  it("calls onChange with the account-prefixed value", () => {
    const onChange = vi.fn();
    render(
      <ModelSelect
        value="openai-codex::gpt-5"
        options={[
          option({
            value: "acc-1::openai-codex::gpt-5",
            label: "GPT-5",
            providerID: "openai-codex",
            modelID: "gpt-5",
            accountId: "acc-1",
            accountLabel: "仕事用",
          }),
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT-5/ }));
    expect(onChange).toHaveBeenCalledWith("acc-1::openai-codex::gpt-5");
  });
});
