// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => client);

import { SessionLabelSettings } from "./SessionLabelSettings";
import { JEV_MODEL_CHANGED_EVENT } from "@/lib/jev-model-settings";

const usableJev = {
  settings: { provider: "registered", enabledModels: [{ providerId: "typesafe", modelId: "jev" }] },
  models: [{ providerId: "typesafe", modelId: "jev", providerEnabled: true }],
};

function mockServer(options: { jev?: unknown; global?: string | null; labelJev?: string | null; labels?: string | null }) {
  client.getJson.mockImplementation((path: string) => {
    if (path === "/api/jev-model") return Promise.resolve(options.jev ?? usableJev);
    if (path === "/api/settings/auto-jev-enabled") return Promise.resolve({ value: "global" in options ? options.global : "1" });
    if (path === "/api/settings/session-label-jev") return Promise.resolve({ value: options.labelJev ?? null });
    if (path === "/api/settings/session-labels") return Promise.resolve({ value: options.labels ?? null });
    return Promise.resolve({ value: null });
  });
}

const toggle = () => screen.getByRole("switch");

describe("SessionLabelSettings Jev toggle", () => {
  beforeEach(() => {
    client.getJson.mockReset();
    client.sendJson.mockReset();
    client.sendJson.mockResolvedValue({ value: "0" });
    globalThis.localStorage.clear();
  });
  afterEach(cleanup);

  it("is forced OFF without a usable Jev model and re-checks after model changes", async () => {
    mockServer({ jev: { settings: { provider: "registered", enabledModels: [] }, models: [] } });
    render(<SessionLabelSettings />);
    await screen.findByText(/Jevモデルが登録されていないため無効です/);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);

    mockServer({});
    window.dispatchEvent(new Event(JEV_MODEL_CHANGED_EVENT));
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  });

  it("is forced OFF while Jev is disabled globally", async () => {
    mockServer({ global: null });
    render(<SessionLabelSettings />);
    await screen.findByText(/Jev判定が全体で無効のため無効です/);
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  });

  it("stores OFF on the server", async () => {
    mockServer({});
    render(<SessionLabelSettings />);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(client.sendJson).toHaveBeenCalledWith("/api/settings/session-label-jev", { value: "0" }, "PUT");
  });

  it("replaces a stale local label cache with the server value edited on another PC", async () => {
    localStorage.setItem("webui:session-labels", JSON.stringify([{ id: "code", name: "コード", hint: "", color: "blue" }]));
    mockServer({ labels: JSON.stringify([{ id: "code", name: "実装", hint: "", color: "blue" }]) });
    render(<SessionLabelSettings />);
    await waitFor(() => expect(screen.getByDisplayValue("実装")).toBeTruthy());
  });});
