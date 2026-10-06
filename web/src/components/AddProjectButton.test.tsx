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

  it("selects the clicked home folder rather than the previous directory", async () => {
    const home = "C:\\Users\\Daichi";
    const folder = `${home}\\Desktop`;
    getJson.mockResolvedValueOnce({
      path: home,
      parent: null,
      quickAccess: [{ name: "ホーム", path: home, kind: "home" }],
      entries: [{ name: "Desktop", path: folder }],
    }).mockResolvedValueOnce({ path: folder, parent: home, entries: [] });
    const onSelect = vi.fn();

    render(<AddProjectButton label="参照" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "参照" }));
    fireEvent.click(await screen.findByRole("button", { name: /Desktop/ }));
    await screen.findByDisplayValue(folder);
    await act(async () => { await Promise.resolve(); });
    expect(getJson).toHaveBeenLastCalledWith("/api/browse/dirs", { path: folder });
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    expect(onSelect).toHaveBeenCalledWith(folder);
  });

  it.each(["request", "listing"])("does not select the old home path after a %s failure", async (failure) => {
    const home = "C:\\Users\\Daichi";
    const folder = `${home}\\Desktop`;
    getJson.mockResolvedValueOnce({
      path: home,
      parent: null,
      entries: [{ name: "Desktop", path: folder }],
    });
    if (failure === "request") getJson.mockRejectedValueOnce(new Error("参照できません"));
    else getJson.mockResolvedValueOnce({ path: folder, parent: home, entries: [], error: "参照できません" });
    const onSelect = vi.fn();

    render(<AddProjectButton label="参照" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "参照" }));
    fireEvent.click(await screen.findByRole("button", { name: /Desktop/ }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("フォルダーのパス") as HTMLInputElement).value).toBe(folder);
    const select = screen.getByRole("button", { name: "選択" }) as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    fireEvent.click(select);
    expect(onSelect).not.toHaveBeenCalled();

    getJson.mockResolvedValueOnce({ path: folder, parent: home, entries: [] });
    fireEvent.click(screen.getByRole("button", { name: "移動" }));
    await act(async () => { await Promise.resolve(); });
    expect(select.disabled).toBe(false);
    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledWith(folder);
  });

  it("does not add the old home directory after a navigation failure", async () => {
    getJson.mockResolvedValueOnce({
      path: "C:\\Users\\Daichi",
      parent: null,
      entries: [{ name: "Desktop", path: "C:\\Users\\Daichi\\Desktop" }],
    }).mockRejectedValueOnce(new Error("参照できません"));
    sendJson.mockRejectedValueOnce(new Error("Native picker unavailable"));

    render(<AddProjectButton />);
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを追加" }));
    fireEvent.click(await screen.findByRole("button", { name: /Desktop/ }));
    await screen.findByRole("alert");
    const add = screen.getByRole("button", { name: "追加" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(sendJson).not.toHaveBeenCalledWith("/api/projects", expect.anything());
  });

  it("still permits a manually entered path after a failed navigation", async () => {
    getJson.mockResolvedValueOnce({ path: "C:\\Users\\Daichi", parent: null, entries: [] });
    getJson.mockRejectedValueOnce(new Error("参照できません"));
    const onSelect = vi.fn();

    render(<AddProjectButton label="参照" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "参照" }));
    await screen.findByDisplayValue("C:\\Users\\Daichi");
    fireEvent.click(screen.getByRole("button", { name: "移動" }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("フォルダーのパス"), { target: { value: "D:\\Projects" } });
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    expect(onSelect).toHaveBeenCalledWith("D:\\Projects");
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
