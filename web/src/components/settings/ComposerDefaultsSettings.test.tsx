// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));
vi.mock("@/lib/client", () => mocks);

import {
  ComposerDefaultsSettings,
  ComposerPromptPresetsSettings,
} from "./ComposerDefaultsSettings";
import { writeComposerDefaults } from "@/lib/composer-defaults";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getJson.mockResolvedValue({ models: [], agents: [] });
  mocks.sendJson.mockResolvedValue({ value: "[]" });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ComposerDefaultsSettings model mapping", () => {
  it("keeps thinking levels when an account-prefixed default maps to an integrated option", async () => {
    const pending = deferred<{ models: ModelOption[] }>();
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/models") return pending.promise;
      if (path === "/api/agents") return Promise.resolve({ agents: [] });
      return Promise.resolve({});
    });
    writeComposerDefaults({
      model: "acc-1::provider::model-a",
      autoOptimize: "balanced",
      agent: "__auto__",
    });

    render(<ComposerDefaultsSettings />);

    await act(async () => {
      pending.resolve({
        models: [
          {
            value: "provider::model-a",
            label: "Model A",
            providerID: "provider",
            modelID: "model-a",
            routingMode: "integrated",
            thinkingLevels: ["off", "high"],
          },
        ],
      });
    });

    await waitFor(() => {
      const modelButton = screen.getByRole("button", { name: "既定のモデル" });
      expect(modelButton.textContent).toContain("Model A");
    });
    expect(screen.getByRole("button", { name: "思考レベル" })).toBeTruthy();
    expect(screen.queryByText(/未接続/)).toBeNull();
  });

  it("warns when the stored default agent is disabled", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/models") return Promise.resolve({ models: [] });
      if (path === "/api/agents")
        return Promise.resolve({ agents: [{ name: "builder", enabled: true }] });
      return Promise.resolve({});
    });
    writeComposerDefaults({
      model: "auto",
      autoOptimize: "balanced",
      agent: "ghost-agent",
    });

    render(<ComposerDefaultsSettings />);

    await waitFor(() => {
      expect(screen.getByText(/「ghost-agent」は無効です/)).toBeTruthy();
    });
  });

  it("does not read localStorage during server render", () => {
    localStorage.setItem("leafcodepi.composerPromptPresets", JSON.stringify(["サーバー描画では表示しない"]));
    const previousWindow = globalThis.window;
    const previousLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    try {
      const html = renderToStaticMarkup(<ComposerPromptPresetsSettings />);
      expect(html).not.toContain("送信プロンプトのプリセット");
      expect(html).not.toContain("サーバー描画では表示しない");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocalStorage });
    }
  });

  it("adds, edits, and deletes a body-only prompt preset from settings", () => {
    render(<ComposerPromptPresetsSettings />);

    fireEvent.click(screen.getByRole("button", { name: "プリセットを追加" }));
    expect(screen.queryByRole("textbox", { name: "プリセット名" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "送信プロンプト本文" }), { target: { value: "変更を確認してください" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("変更を確認してください")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "プリセットを追加" }));
    fireEvent.change(screen.getByRole("textbox", { name: "送信プロンプト本文" }), { target: { value: "変更を確認してください" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert").textContent).toBe("同じ本文のプリセットは登録できません");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    fireEvent.click(screen.getByRole("button", { name: "1番目のプリセットを編集" }));
    fireEvent.change(screen.getByRole("textbox", { name: "送信プロンプト本文" }), { target: { value: "変更を詳しく確認してください" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("変更を詳しく確認してください")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1番目のプリセットを削除" }));
    expect(screen.queryByText("変更を詳しく確認してください")).toBeNull();
    expect(screen.queryByRole("list", { name: "送信プロンプトのプリセット" })).toBeNull();
    expect(screen.getByRole("heading", { name: "送信プロンプト" }).closest("section")?.querySelector(".mt-3")).toBeNull();
  });
});
