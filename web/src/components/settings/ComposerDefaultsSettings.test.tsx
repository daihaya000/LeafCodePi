// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
}));
vi.mock("@/lib/client", () => mocks);

import { ComposerDefaultsSettings } from "./ComposerDefaultsSettings";
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
});
