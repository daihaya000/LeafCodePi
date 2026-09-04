// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
