// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

import { BrowserSettings } from "./BrowserSettings";

afterEach(() => {
  cleanup();
  getJson.mockReset();
  sendJson.mockReset();
});

describe("BrowserSettings", () => {
  it("keeps the latest reload result when earlier responses arrive later", async () => {
    type Config = { autoOpenBrowser: boolean };
    let resolveFirst!: (value: Config) => void;
    let resolveSecond!: (value: Config) => void;
    let resolveThird!: (value: Config) => void;
    const first = new Promise<Config>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Config>((resolve) => { resolveSecond = resolve; });
    const third = new Promise<Config>((resolve) => { resolveThird = resolve; });
    const responses = [first, second, third];
    getJson.mockImplementation(() => responses.shift());

    render(<BrowserSettings />);
    const reload = screen.getByRole("button", { name: "再読込" });
    fireEvent.click(reload);
    fireEvent.click(reload);
    expect(getJson).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveThird({ autoOpenBrowser: true });
      await third;
    });
    expect(screen.getByText("自動で開く")).toBeTruthy();

    await act(async () => {
      resolveSecond({ autoOpenBrowser: false });
      resolveFirst({ autoOpenBrowser: false });
      await Promise.all([first, second]);
    });
    expect(screen.getByText("自動で開く")).toBeTruthy();
  });
});
