// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffPane } from "@/components/task/DiffPane";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({
  getJson: mocks.getJson,
  sendJson: mocks.sendJson,
}));

const files = [
  {
    path: "src/a.ts",
    additions: 1,
    deletions: 0,
    binary: false,
    untracked: false,
    hunks: [],
  },
  {
    path: "src/b.ts",
    additions: 0,
    deletions: 2,
    binary: false,
    untracked: true,
    hunks: [],
  },
];

function mockDiffPayload() {
  mocks.getJson.mockImplementation((path: string) => {
    if (path === "/api/diff/files") {
      return Promise.resolve({
        git: true,
        branch: "master",
        files,
        additions: 1,
        deletions: 2,
      });
    }
    if (path === "/api/git/branches") {
      return Promise.resolve({
        current: "master",
        branches: ["master"],
        defaultTarget: null,
        hasRemote: false,
      });
    }
    if (path === "/api/git/pr") return Promise.resolve({ available: false });
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

describe("DiffPane 全選択", () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
    mocks.sendJson.mockReset();
    mockDiffPayload();
  });

  afterEach(() => {
    cleanup();
  });

  it("ヘッダの全選択チェックボックスで表示中のファイルの選択状態が切り替わる", async () => {
    render(<DiffPane directory="C:\\repo" />);
    await screen.findByText("a.ts");

    const header = screen.getByRole("checkbox", {
      name: "表示中のファイルをすべてコミット対象にする",
    });
    // 初期状態は全ファイルが選択されている
    expect((header as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "src/a.ts をコミット対象にする" }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    // 全解除 → 各ファイルの選択が外れる
    fireEvent.click(header);
    await waitFor(() => {
      expect((header as HTMLInputElement).checked).toBe(false);
      expect(
        (
          screen.getByRole("checkbox", { name: "src/a.ts をコミット対象にする" }) as HTMLInputElement
        ).checked,
      ).toBe(false);
      expect(
        (
          screen.getByRole("checkbox", { name: "src/b.ts をコミット対象にする" }) as HTMLInputElement
        ).checked,
      ).toBe(false);
    });

    // 再選択 → 全ファイルが選択され、Commit パネルの件数にも反映される
    fireEvent.click(header);
    await waitFor(() => {
      expect((header as HTMLInputElement).checked).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit パネル" }));
    expect(screen.getByRole("button", { name: "コミット (2)" })).toBeTruthy();
  });

  it("個別解除後は全選択チェックが外れ、選択数が減る", async () => {
    render(<DiffPane directory="C:\\repo" />);
    await screen.findByText("a.ts");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "src/b.ts をコミット対象にする" }),
    );
    await waitFor(() => {
      expect(
        (
          screen.getByRole("checkbox", {
            name: "表示中のファイルをすべてコミット対象にする",
          }) as HTMLInputElement
        ).checked,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Commit パネル" }));
    expect(screen.getByRole("button", { name: "コミット (1)" })).toBeTruthy();
  });

  it("変更のみ表示でコンテキスト行が隠れ、変更行は残る", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/diff/files") {
        return Promise.resolve({
          git: true,
          branch: "master",
          files: [
            {
              path: "src/a.ts",
              additions: 1,
              deletions: 1,
              binary: false,
              untracked: false,
              hunks: [
                {
                  header: "@@ -1,3 +1,3 @@",
                  lines: [
                    { t: " ", text: "const a = 1;" },
                    { t: "-", text: "const b = 2;" },
                    { t: "+", text: "const b = 3;" },
                  ],
                },
              ],
            },
          ],
          additions: 1,
          deletions: 1,
        });
      }
      if (path === "/api/git/branches") {
        return Promise.resolve({
          current: "master",
          branches: ["master"],
          defaultTarget: null,
          hasRemote: false,
        });
      }
      if (path === "/api/git/pr") return Promise.resolve({ available: false });
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    render(<DiffPane directory="C:\\repo" />);
    await screen.findByText("a.ts");

    fireEvent.click(screen.getByRole("button", { name: "src/a.ts の差分を展開" }));
    const card = screen.getByRole("button", { name: "src/a.ts の差分を折りたたむ" }).closest(
      ".rounded-xl",
    );
    const diffArea = card?.querySelector(".overflow-x-auto");
    expect(diffArea?.textContent).toContain("const a = 1;");

    fireEvent.click(
      screen.getByRole("button", { name: "コンテキスト行を隠して変更行のみ表示" }),
    );
    expect(diffArea?.textContent).not.toContain("const a = 1;");
    expect(diffArea?.textContent).toContain("const b = 3;");
  });
});