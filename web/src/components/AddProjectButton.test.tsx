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
  it("gives a long directory list a constrained scroll viewport", async () => {
    getJson.mockResolvedValue({
      path: "C:\\Users\\Daichi",
      parent: null,
      entries: Array.from({ length: 40 }, (_, index) => ({
        name: `Folder ${index}`,
        path: `C:\\Users\\Daichi\\Folder ${index}`,
      })),
    });

    render(<AddProjectButton />);
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを追加" }));

    await screen.findByText("Folder 39");
    const dialog = screen.getByRole("dialog");
    const list = screen.getByText("Folder 39").closest("ul");
    expect(dialog.className).toContain("h-[min(46rem,calc(100dvh-2rem))]");
    expect(list?.className).toContain("overflow-y-auto");
  });

  it("uses the in-app picker when selecting a directory for another flow", async () => {
    getJson.mockResolvedValue({
      path: "C:\\Users\\Daichi",
      parent: null,
      entries: [{ name: "Project", path: "C:\\Users\\Daichi\\Project" }],
    });
    const onSelect = vi.fn();

    render(<AddProjectButton label="参照" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "参照" }));

    await screen.findByText("Project");
    expect(getJson).toHaveBeenCalledWith("/api/browse/dirs", undefined);
    expect(sendJson).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Daichi");
  });

  it("shows another drive and navigates to it", async () => {
    getJson.mockResolvedValueOnce({
      path: "C:\\Users\\Daichi",
      parent: null,
      drives: [{ name: "D:", path: "D:\\" }],
      entries: [],
    }).mockResolvedValueOnce({ path: "D:\\", parent: null, drives: [], entries: [] });

    render(<AddProjectButton label="参照" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "参照" }));
    await screen.findByRole("heading", { name: "ドライブ" });
    fireEvent.click(screen.getByRole("button", { name: "D:" }));

    expect(getJson).toHaveBeenCalledWith("/api/browse/dirs", { path: "D:\\" });
    expect(await screen.findByDisplayValue("D:\\")).toBeTruthy();
  });

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
