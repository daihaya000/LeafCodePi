// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));
vi.mock("@/lib/events", () => ({ notifyTasksChanged: vi.fn() }));

import { AddProjectButton } from "./AddProjectButton";

afterEach(() => {
  cleanup();
  getJson.mockReset();
  sendJson.mockReset();
});

describe("AddProjectButton", () => {
  it("ignores a directory response from a dialog opened before the current one", async () => {
    let resolveFirst!: (value: { path: string; parent: null; entries: never[] }) => void;
    let resolveSecond!: (value: { path: string; parent: null; entries: never[] }) => void;
    const firstRequest = new Promise<{ path: string; parent: null; entries: never[] }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondRequest = new Promise<{ path: string; parent: null; entries: never[] }>((resolve) => {
      resolveSecond = resolve;
    });
    let requestCount = 0;
    getJson.mockImplementation(() => (requestCount++ === 0 ? firstRequest : secondRequest));

    render(<AddProjectButton />);
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを追加" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "プロジェクトを追加" }));
      await Promise.resolve();
    });
    expect(getJson).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirst({ path: "C:\\old", parent: null, entries: [] });
      await Promise.resolve();
    });
    expect(screen.getByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByDisplayValue("C:\\old")).toBeNull();

    await act(async () => {
      resolveSecond({ path: "C:\\new", parent: null, entries: [] });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("C:\\new")).toBeTruthy();
  });
});
