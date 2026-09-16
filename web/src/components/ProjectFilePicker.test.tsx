// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);

import { ProjectFilePicker } from "./ProjectFilePicker";

const rootListing = {
  path: "",
  parent: null,
  entries: [
    { name: "src", path: "src", kind: "dir" as const },
    { name: "a.ts", path: "a.ts", kind: "file" as const, size: 5 },
  ],
  truncated: false,
};

const srcListing = {
  path: "src",
  parent: "",
  entries: [{ name: "b.ts", path: "src/b.ts", kind: "file" as const, size: 5 }],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getJson.mockImplementation((_path: string, params?: Record<string, string>) => {
    if (params?.read === "1") {
      return Promise.resolve({ name: "src/b.ts", mimeType: "text/plain", size: 5, data: "aGVsbG8=" });
    }
    return Promise.resolve(params?.path === "src" ? srcListing : rootListing);
  });
});

afterEach(cleanup);

async function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "プロジェクトのファイルを選択" }));
  await screen.findByRole("dialog", { name: "プロジェクトのファイルを選択" });
}

describe("ProjectFilePicker", () => {
  it("browses folders and adds a picked file as a text attachment", async () => {
    const onPick = vi.fn();
    render(<ProjectFilePicker projectId="p1" attachments={[]} onPick={onPick} />);
    await openPicker();

    expect(mocks.getJson).toHaveBeenCalledWith("/api/projects/p1/files", undefined);
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    await waitFor(() =>
      expect(mocks.getJson).toHaveBeenCalledWith("/api/projects/p1/files", { path: "src" }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /b\.ts/ }));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({
        uri: "data:text/plain;base64,aGVsbG8=",
        mime: "text/plain",
        name: "src/b.ts",
      }),
    );
  });

  it("keeps an already attached file from being added twice", async () => {
    const onPick = vi.fn();
    render(
      <ProjectFilePicker
        projectId="p1"
        attachments={[{ uri: "data:text/plain;base64,eA==", mime: "text/plain", name: "src/b.ts" }]}
        onPick={onPick}
      />,
    );
    await openPicker();
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));

    const row = await screen.findByRole("button", { name: /b\.ts/ });
    await waitFor(() => expect(row.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute("aria-pressed")).toBe("true"));
    expect(mocks.getJson.mock.calls.some(([, params]) => params?.read === "1")).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("follows the disabled state the composer passes in", () => {
    render(<ProjectFilePicker projectId="p1" attachments={[]} onPick={vi.fn()} disabled />);

    const trigger = screen.getByRole("button", {
      name: "プロジェクトのファイルを選択",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it("surfaces a read failure without adding an attachment", async () => {
    mocks.getJson.mockImplementation((_path: string, params?: Record<string, string>) => {
      if (params?.read === "1") {
        return Promise.reject(new Error("UTF-8テキストのみ添付できます"));
      }
      return Promise.resolve(rootListing);
    });
    const onPick = vi.fn();
    render(<ProjectFilePicker projectId="p1" attachments={[]} onPick={onPick} />);
    await openPicker();

    fireEvent.click(await screen.findByRole("button", { name: /a\.ts/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("UTF-8テキストのみ添付できます");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes with Escape", async () => {
    render(<ProjectFilePicker projectId="p1" attachments={[]} onPick={vi.fn()} />);
    await openPicker();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uses the task workspace endpoint when no project is selected", async () => {
    render(<ProjectFilePicker taskId="t1" attachments={[]} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "作業フォルダーのファイルを選択" }));
    await screen.findByRole("dialog", { name: "作業フォルダーのファイルを選択" });

    expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks/t1/files", undefined);
  });

  it("renders nothing without a scope", () => {
    const { container } = render(<ProjectFilePicker attachments={[]} onPick={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
