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

  it("uses the same 90% danger threshold as CodexBar", () => {
    expect(
      modelLimitReached(option({ codexbarUsedPercent: 90, codexbarMaxed: false })),
    ).toBe(true);
  });

  it("honors an explicit provider limit flag", () => {
    expect(
      modelLimitReached(option({ codexbarUsedPercent: 10, codexbarLimited: true })),
    ).toBe(true);
  });
});

describe("integrated model colors", () => {
  it("uses the integrated percentage instead of the selected candidate", () => {
    const integrated = option({
      routingMode: "integrated",
      codexbarUsedPercent: 100,
      codexbarMaxed: true,
      codexbarIntegratedUsedPercent: 60,
    });

    expect(modelNearLimit(integrated)).toBe(false);
    expect(modelLimitReached(integrated)).toBe(false);
  });

  it("uses the integrated percentage thresholds", () => {
    const nearLimit = option({
      routingMode: "integrated",
      codexbarIntegratedUsedPercent: 75,
    });
    const limitReached = option({
      routingMode: "integrated",
      codexbarIntegratedUsedPercent: 90,
    });

    expect(modelNearLimit(nearLimit)).toBe(true);
    expect(modelLimitReached(nearLimit)).toBe(false);
    expect(modelNearLimit(limitReached)).toBe(false);
    expect(modelLimitReached(limitReached)).toBe(true);
  });

  it("does not use candidate usage when integrated usage is unknown", () => {
    const integrated = option({
      routingMode: "integrated",
      codexbarUsedPercent: 100,
      codexbarMaxed: true,
      codexbarIntegratedUsedPercent: null,
    });

    expect(modelNearLimit(integrated)).toBe(false);
    expect(modelLimitReached(integrated)).toBe(false);
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

  it("shows an integrated model label for an account-prefixed stored value", () => {
    render(
      <ModelSelect
        value="acc-1::anthropic::claude"
        options={[
          option({
            value: "anthropic::claude",
            label: "Claude",
            routingMode: "integrated",
          }),
        ]}
        onChange={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "モデル" });
    expect(trigger.textContent).toContain("Claude");
    expect(trigger.textContent).not.toContain("モデルなし");
    expect(trigger.title).toContain("Claude");
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

  it("marks image-capable models and omits the mark for text-only models", () => {
    const vision = option({
      value: "llama-server::vision",
      label: "Qwen3.8-27B-Uncensored",
      providerID: "llama-server",
      modelID: "vision",
      input: ["text", "image"],
    });
    const textOnly = option({
      value: "llama-server::text",
      label: "Text",
      providerID: "llama-server",
      modelID: "text",
      input: ["text"],
    });

    const view = render(
      <ModelSelect value="llama-server::vision" options={[vision, textOnly]} onChange={() => {}} />,
    );
    expect(screen.queryAllByLabelText("画像入力対応").length).toBe(1);

    // 開いたメニューでも同じ判定: 画像対応の行だけにマークが付く。
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    expect(screen.queryAllByLabelText("画像入力対応").length).toBe(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    view.rerender(
      <ModelSelect value="llama-server::text" options={[vision, textOnly]} onChange={() => {}} />,
    );
    expect(screen.queryAllByLabelText("画像入力対応").length).toBe(0);
  });
});

describe("ModelSelect average tok/s", () => {
  it("shows the average rate and colors under 50 red and 100 or more green", () => {
    render(
      <ModelSelect
        value="anthropic::claude"
        options={[
          option({ avgTokensPerSecond: 42.4 }),
          option({ value: "openai::gpt", label: "GPT", providerID: "openai", modelID: "gpt", avgTokensPerSecond: 80 }),
          option({ value: "openai::fast", label: "Fast", providerID: "openai", modelID: "fast", avgTokensPerSecond: 100 }),
          option({ value: "openai::mini", label: "Mini", providerID: "openai", modelID: "mini" }),
        ]}
        onChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    expect(screen.getByText("42 tok/s").className).toContain("text-danger");
    expect(screen.getByText("80 tok/s").className).toContain("text-faint");
    expect(screen.getByText("100 tok/s").className).toContain("text-success");
    expect(screen.getAllByTitle("平均 tok/s 実績")).toHaveLength(3);
  });
});
