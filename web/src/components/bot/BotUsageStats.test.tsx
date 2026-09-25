// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "@/lib/types";
import { BotUsageStats } from "./BotUsageStats";

afterEach(cleanup);

const assistant = (id: string, createdAt: number, outputTokens: number, tokensPerSecond?: number): UiMessage => ({
  id, role: "assistant", createdAt, parts: [], outputTokens, ...(tokensPerSecond ? { tokensPerSecond } : {}),
});

describe("BotUsageStats", () => {
  it("shows context usage, output tok, average tok/s and duration like the Code header", () => {
    render(
      <BotUsageStats
        contextUsage={{ tokens: 12_000, contextWindow: 100_000, percent: 12 }}
        messages={[
          { id: "u", role: "user", createdAt: 0, parts: [] },
          assistant("a1", 1_000, 1_000, 20),
          assistant("a2", 3_000, 500, 40),
          assistant("a3", 4_000, 0),
        ]}
      />,
    );
    expect(screen.getByTitle(/コンテキスト使用量/).textContent).toContain("12k/100k (12%)");
    expect(screen.getByTitle("合計出力トークン").textContent).toBe("1.5k tok");
    expect(screen.getByTitle("平均 tok/s").textContent).toBe("30 tok/s");
    expect(screen.getByTitle("合計生成時間（メッセージ間隔の累計）")).toBeTruthy();
  });

  it("renders nothing without usage data", () => {
    const { container } = render(<BotUsageStats messages={[]} />);
    expect(container.textContent).toBe("");
  });
});
