// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/lib/types";
import { ModelSelect, modelLimitReached, modelNearLimit } from "./ModelSelect";

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
    expect(screen.getByText("llama-server")).toBeTruthy();
    expect(screen.getByText("openai-codex · 仕事用")).toBeTruthy();
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