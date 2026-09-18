// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionSettings } from "./CompactionSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("CompactionSettings", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) =>
      path === "/api/compaction-settings"
        ? Promise.resolve({
            settings: {
              enabled: false,
              reserveTokens: 16_384,
              keepRecentTokens: 20_000,
            },
          })
        : Promise.resolve({ value: null }),
    );
    sendJson.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("Jev設定も共通カードのSwitchと割合表示を使う", async () => {
    render(<CompactionSettings />);

    const toggle = await screen.findByRole("switch", { name: "Jevコンパクションを有効化" });
    expect(screen.queryByLabelText("Jevコンパクションの残す確率")).toBeNull();
    fireEvent.click(toggle);

    const threshold = screen.getByLabelText("Jevコンパクションの残す確率");
    expect((threshold as HTMLSelectElement).value).toBe("0.6");
    expect(screen.getByText("未満のツール結果を省略")).toBeTruthy();
    fireEvent.change(threshold, { target: { value: "0.75" } });

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/jev-compaction-enabled",
      { value: "1" },
      "PUT",
    ));
    expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/jev-compaction-threshold",
      { value: "0.75" },
      "PUT",
    );
  });

  it("入力を共通のグリッドに並べ、コンテナ内で伸縮させる", async () => {
    render(<CompactionSettings />);

    const action = await screen.findByLabelText("動作");
    const threshold = screen.getByLabelText("コンテキスト使用率の閾値");

    expect((action as HTMLSelectElement).value).toBe("auto");
    expect(action.parentElement?.className).toContain("block");
    expect(action.className).toContain("w-full");
    expect(threshold.className).toContain("min-w-0");
    expect(threshold.parentElement?.className).toContain("flex");
    expect(action.parentElement?.parentElement?.className).toContain("grid");
  });
});
