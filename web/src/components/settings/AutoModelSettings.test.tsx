// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => client);

import { AutoModelSettings } from "./AutoModelSettings";
import { writeAutoOptimizeMode } from "@/lib/auto-settings";

describe("AutoModelSettings", () => {
  beforeEach(() => {
    client.getJson.mockReset();
    client.sendJson.mockReset();
    client.sendJson.mockResolvedValue({});
    globalThis.localStorage.clear();
  });
  afterEach(cleanup);

  it("shows a loading state and then the fetched models", async () => {
    client.getJson.mockImplementation((path: string) =>
      path === "/api/models"
        ? Promise.resolve({
            models: [
              {
                value: "provider::model-a",
                label: "Model A",
                providerID: "provider",
                modelID: "model-a",
              },
            ],
          })
        : Promise.resolve({ value: null }),
    );
    render(<AutoModelSettings />);
    expect(screen.getByText("モデルを読み込み中…")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("モデルを読み込み中…")).toBeNull());
    expect(screen.getByText("Auto ルーティング設定")).toBeTruthy();
  });

  it("reports a fetch failure without crashing", async () => {
    client.getJson.mockImplementation((path: string) =>
      path === "/api/models"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ value: null }),
    );
    render(<AutoModelSettings />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("offline"));
    // The rest of the panel still renders even though the fetch failed.
    expect(screen.getByText("Auto ルーティング設定")).toBeTruthy();
  });

  it("shows the empty-models notice once loading finishes with no models", async () => {
    client.getJson.mockImplementation((path: string) =>
      path === "/api/models"
        ? Promise.resolve({ models: [] })
        : Promise.resolve({ value: null }),
    );
    render(<AutoModelSettings />);
    await waitFor(() => expect(screen.queryByText("モデルを読み込み中…")).toBeNull());
    expect(screen.getByText("利用可能なモデルがありません。")).toBeTruthy();
  });

  it("keeps a locally stored mode instead of the server value", async () => {
    // A stored local setting must win over what the server reports, so the
    // user's explicit choice is never silently overwritten on load.
    writeAutoOptimizeMode("intelligence");
    client.getJson.mockImplementation((path: string) =>
      path === "/api/models"
        ? Promise.resolve({ models: [] })
        : Promise.resolve({ value: "cost" }),
    );
    render(<AutoModelSettings />);
    await waitFor(() => expect(screen.queryByText("モデルを読み込み中…")).toBeNull());
    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.textContent ?? "");
    // The active-mode marker "*" is expected here because the component's own
    // mode state (kept local, from the stored setting) matches the editor's
    // current mode prop.
    expect(pressed).toEqual(["知能優先*"]);
  });

  it("restores a valid server mode when the local mode is invalid", async () => {
    localStorage.setItem("webui:auto-optimize", "invalid");
    client.getJson.mockImplementation((path: string) => {
      if (path === "/api/models") return Promise.resolve({ models: [] });
      if (path === "/api/settings/auto-optimize") return Promise.resolve({ value: "intelligence" });
      return Promise.resolve({ value: null });
    });

    render(<AutoModelSettings />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Auto の最適化" }).textContent).toContain("知能優先");
    });
  });

  it("restores a valid server route when the local route config is corrupt", async () => {
    localStorage.setItem("webui:auto-route-overrides", "{broken");
    const routeConfig = JSON.stringify({
      version: 2,
      modes: {
        cost: {
          light: {
            candidates: [{ kind: "model", providerID: "provider", modelID: "model-a" }],
          },
        },
      },
    });
    client.getJson.mockImplementation((path: string) => {
      if (path === "/api/models") {
        return Promise.resolve({
          models: [{
            value: "provider::model-a",
            label: "Model A",
            providerID: "provider",
            modelID: "model-a",
          }],
        });
      }
      if (path === "/api/settings/auto-optimize") return Promise.resolve({ value: "cost" });
      if (path === "/api/settings/auto-route-overrides") return Promise.resolve({ value: routeConfig });
      return Promise.resolve({ value: null });
    });

    render(<AutoModelSettings />);
    await waitFor(() => expect(screen.getByText("Model A")).toBeTruthy());
  });

  it("keeps a route edit made before server settings resolve", async () => {
    let resolveServerRoute!: (value: string | null) => void;
    const serverRoute = new Promise<string | null>((resolve) => {
      resolveServerRoute = resolve;
    });
    const modelA = {
      value: "provider::model-a",
      label: "Model A",
      providerID: "provider",
      modelID: "model-a",
    };
    const modelB = {
      value: "provider::model-b",
      label: "Model B",
      providerID: "provider",
      modelID: "model-b",
    };
    client.getJson.mockImplementation((path: string) => {
      if (path === "/api/models") return Promise.resolve({ models: [modelA, modelB] });
      if (path === "/api/settings/auto-optimize") return Promise.resolve({ value: "cost" });
      if (path === "/api/settings/auto-route-overrides") return serverRoute.then((value) => ({ value }));
      return Promise.resolve({ value: null });
    });

    render(<AutoModelSettings />);
    const addButtons = await screen.findAllByRole("button", { name: "候補を追加" });
    fireEvent.click(addButtons[0]!);
    const candidate = await screen.findByRole("button", { name: "候補1のモデル" });
    expect(candidate.textContent).toContain("Model A");

    await act(async () => {
      resolveServerRoute(JSON.stringify({
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [{ kind: "model", providerID: "provider", modelID: "model-b" }],
            },
          },
        },
      }));
    });
    await waitFor(() => expect(candidate.textContent).toContain("Model A"));
  });
});
