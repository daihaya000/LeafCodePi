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

  it("狭い画面ではラベルと入力を縦に並べ、入力幅をコンテナ内に収める", async () => {
    render(<CompactionSettings />);

    const action = await screen.findByLabelText("動作");
    const threshold = screen.getByLabelText("コンテキスト使用率の閾値");

    expect(action.parentElement?.className).toContain("flex-col");
    expect(action.className).toContain("w-full");
    expect(action.className).not.toContain("w-84");
    expect(threshold.parentElement?.parentElement?.className).toContain("flex-col");
    expect(threshold.className).toContain("min-w-0");
    expect(threshold.className).not.toContain("w-60");
  });
});
