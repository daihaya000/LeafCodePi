// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
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

  it("入力を共通のグリッドに並べ、コンテナ内で伸縮させる", async () => {
    render(<CompactionSettings />);

    const action = await screen.findByLabelText("動作");
    const threshold = screen.getByLabelText("コンテキスト使用率の閾値");

    expect(action.parentElement?.className).toContain("block");
    expect(action.className).toContain("w-full");
    expect(threshold.className).toContain("min-w-0");
    expect(threshold.parentElement?.className).toContain("flex");
    expect(action.parentElement?.parentElement?.className).toContain("grid");
  });
});
