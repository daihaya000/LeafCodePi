// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/lib/client", () => mocks);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/AddProjectButton", () => ({ AddProjectButton: () => null }));
vi.mock("@/components/home/NextTaskSuggest", () => ({ NextTaskSuggest: () => null }));
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuHeader: () => null }));

import { HomeView } from "./HomeView";
import { clearCachedModels, writeCachedModels } from "@/lib/models-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function model(value: string, label: string): ModelOption {
  const [providerID, modelID] = value.split("::");
  return { value, label, providerID: providerID!, modelID: modelID! };
}

let modelResponses: Promise<{ models: ModelOption[] }>[] = [];

beforeEach(() => {
  localStorage.clear();
  clearCachedModels();
  vi.clearAllMocks();
  modelResponses = [];
  mocks.getJson.mockImplementation((path: string) => {
    if (path === "/api/models") return modelResponses.shift() ?? Promise.resolve({ models: [] });
    if (path === "/api/projects") return Promise.resolve({ projects: [] });
    if (path === "/api/health") return Promise.resolve({ engineOk: false });
    if (path === "/api/agents") return Promise.resolve({ agents: [] });
    if (path === "/api/skills") return Promise.resolve({ skills: [] });
    if (path.startsWith("/api/settings/")) return Promise.resolve({ value: null });
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearCachedModels();
});

describe("HomeView model refresh", () => {
  it("ignores an older model response after an overlapping refresh", async () => {
    const first = deferred<{ models: ModelOption[] }>();
    const second = deferred<{ models: ModelOption[] }>();
    modelResponses.push(first.promise, second.promise);
    const modelA = model("provider::model-a", "Model A");
    const modelB = model("provider::model-b", "Model B");

    render(<HomeView initialNoProject />);
    await screen.findByText(/Pi に利用可能なモデルがありません/);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(modelResponses).toHaveLength(0));

    await act(async () => { second.resolve({ models: [modelB] }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B"));
    await act(async () => { first.resolve({ models: [modelA] }); });
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B");
  });

  it("keeps the selected model after a health-triggered model reload", async () => {
    const first = deferred<{ models: ModelOption[] }>();
    const second = deferred<{ models: ModelOption[] }>();
    modelResponses.push(first.promise, second.promise);
    const modelA = model("provider::model-a", "Model A");
    const modelB = model("provider::model-b", "Model B");

    render(<HomeView initialNoProject />);
    await act(async () => { first.resolve({ models: [modelA, modelB] }); });
    await screen.findByText("Model A");

    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B");

    await screen.findByText(/Pi に利用可能なモデルがありません/);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(modelResponses).toHaveLength(0));

    await act(async () => { second.resolve({ models: [modelA, modelB] }); });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model B");
    });
  });

  it("falls back to the first available model when the selection disappears", async () => {
    const first = deferred<{ models: ModelOption[] }>();
    const missing = deferred<{ models: ModelOption[] }>();
    modelResponses.push(first.promise, missing.promise);
    const modelA = model("provider::model-a", "Model A");
    const modelB = model("provider::model-b", "Model B");

    render(<HomeView initialNoProject />);
    await act(async () => { first.resolve({ models: [modelA, modelB] }); });
    await screen.findByText("Model A");
    fireEvent.click(screen.getByRole("button", { name: "モデル" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));

    await screen.findByText(/Pi に利用可能なモデルがありません/);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(modelResponses).toHaveLength(0));

    await act(async () => { missing.resolve({ models: [modelA] }); });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    });
  });

  it("keeps working when localStorage reads throw during model restore", async () => {
    const first = deferred<{ models: ModelOption[] }>();
    modelResponses.push(first.promise);
    const modelA = model("provider::model-a", "Model A");

    const spy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    try {
      render(<HomeView initialNoProject />);
      await act(async () => {
        first.resolve({ models: [modelA] });
      });
      // ストレージ例外でも復元が壊れず、先頭モデルへフォールバックする。
      await screen.findByText("Model A");
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the cached model immediately without waiting for /api/models", async () => {
    const pending = deferred<{ models: ModelOption[] }>();
    modelResponses.push(pending.promise);
    const modelA = model("provider::model-a", "Model A");
    localStorage.setItem("leafcodepi.defaultModel", modelA.value);
    writeCachedModels([modelA]);

    render(<HomeView initialNoProject />);

    const trigger = screen.getByRole("button", { name: "モデル" });
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.textContent).toContain("Model A");
    expect(trigger.textContent).not.toContain("モデルなし");
    expect(trigger.textContent).not.toContain("読み込み中");

    await act(async () => {
      pending.resolve({ models: [modelA] });
    });
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
  });

  it("keeps thinking levels when an account-prefixed stored value maps to an integrated option", async () => {
    const pending = deferred<{ models: ModelOption[] }>();
    modelResponses.push(pending.promise);
    const integrated = {
      ...model("provider::model-a", "Model A"),
      routingMode: "integrated" as const,
      thinkingLevels: ["off", "high"] as ModelOption["thinkingLevels"],
    };
    localStorage.setItem("leafcodepi.defaultModel", "acc-1::provider::model-a");
    writeCachedModels([integrated]);

    render(<HomeView initialNoProject />);

    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    expect(screen.getByRole("button", { name: "思考レベル" })).toBeTruthy();

    await act(async () => {
      pending.resolve({ models: [integrated] });
    });
    expect(screen.getByRole("button", { name: "モデル" }).textContent).toContain("Model A");
    expect(screen.getByRole("button", { name: "思考レベル" })).toBeTruthy();
  });
});