// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionSettings } from "./CompactionSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const models = [
  {
    value: "anthropic::claude-haiku",
    label: "Claude Haiku",
    providerID: "anthropic",
    modelID: "claude-haiku",
    thinkingLevels: ["off", "low", "high"],
  },
];

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
        : path === "/api/cache-warming"
          ? Promise.resolve({ mode: "streaming" })
          : path === "/api/models"
            ? Promise.resolve({ models })
            : Promise.resolve({ value: null }),
    );
    sendJson.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("先行生成の既定値と反映を待つ説明を表示し、ON/OFFを保存する", async () => {
    render(<CompactionSettings />);
    const toggle = await screen.findByRole("switch", { name: "圧縮要約の先行生成を無効化" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("先行生成の開始閾値") as HTMLInputElement).value).toBe("70");
    expect(screen.getByText(/反映は既存の圧縮閾値まで待ちます/)).toBeTruthy();
    expect(screen.getByText(/安全余白を最低10%/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/compaction-background-enabled", { value: "0" }, "PUT",
    ));
    await waitFor(() => expect(screen.queryByLabelText("先行生成の開始閾値")).toBeNull());
  });

  it("サーバの先行生成設定を読み込み、開始閾値だけを保存する", async () => {
    const fallback = getJson.getMockImplementation()!;
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/compaction-background-threshold") return Promise.resolve({ value: "80" });
      return fallback(path);
    });
    render(<CompactionSettings />);
    const input = await screen.findByLabelText("先行生成の開始閾値");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("80"));
    fireEvent.change(input, { target: { value: "75" } });
    fireEvent.blur(input);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/compaction-background-threshold", { value: "75" }, "PUT",
    ));
    expect(sendJson).not.toHaveBeenCalledWith("/api/settings/compactionThreshold", expect.anything(), "PUT");
  });

  it("無効な先行生成閾値を保存せず、保存失敗時も元の値に戻す", async () => {
    render(<CompactionSettings />);
    const input = await screen.findByLabelText("先行生成の開始閾値");
    fireEvent.change(input, { target: { value: "90" } }); fireEvent.blur(input);
    expect(sendJson).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("70");
    expect(screen.getByRole("alert").textContent).toContain("50〜85%");
    sendJson.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.change(input, { target: { value: "75" } }); fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("save failed"));
    expect((input as HTMLInputElement).value).toBe("70");
  });

  it("提案・無効モードでは先行生成を操作できない", async () => {
    const fallback = getJson.getMockImplementation()!;
    getJson.mockImplementation((path: string) => path === "/api/settings/compactionAction"
      ? Promise.resolve({ value: "suggest" }) : fallback(path));
    render(<CompactionSettings />);
    const action = await screen.findByLabelText("動作");
    await waitFor(() => expect((action as HTMLSelectElement).value).toBe("suggest"));
    expect((screen.getByRole("switch", { name: "圧縮要約の先行生成を無効化" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("先行生成の開始閾値") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText(/安全余白を最低10%/)).toBeNull();
    fireEvent.change(action, { target: { value: "off" } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/compactionAction", { value: "off" }, "PUT"));
    expect((screen.getByLabelText("先行生成の開始閾値") as HTMLInputElement).disabled).toBe(true);
  });

  it("先行生成スイッチの保存失敗時はON状態を維持する", async () => {
    render(<CompactionSettings />);
    const toggle = await screen.findByRole("switch", { name: "圧縮要約の先行生成を無効化" });
    sendJson.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("save failed"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
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

  it("プロンプトキャッシュの維持モードを保存する", async () => {
    render(<CompactionSettings />);

    const mode = await screen.findByLabelText("維持モード");
    expect((mode as HTMLSelectElement).value).toBe("streaming");
    fireEvent.change(mode, { target: { value: "off" } });

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/cache-warming",
      { mode: "off" },
      "PATCH",
    ));
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

  it("コンパクションモデルとEffortを保存し、クリアでEffortも消す", async () => {
    getJson.mockImplementation((path: string) =>
      path === "/api/models"
        ? Promise.resolve({ models })
        : path === "/api/settings/compaction-model"
          ? Promise.resolve({ value: "anthropic::claude-haiku" })
          : path === "/api/settings/compaction-model-effort"
            ? Promise.resolve({ value: "low" })
            : path === "/api/compaction-settings"
              ? Promise.resolve({ settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } })
              : Promise.resolve({ value: null }),
    );
    render(<CompactionSettings />);

    const effort = await screen.findByRole("button", { name: "コンパクションモデルのEffort" });
    expect(effort.textContent).toContain("low");
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "high" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/compaction-model-effort",
      { value: "high" },
      "PUT",
    ));

    fireEvent.click(screen.getByRole("button", { name: "クリア" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/compaction-model",
      { value: "" },
      "PUT",
    ));
    expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/compaction-model-effort",
      { value: "" },
      "PUT",
    );
    expect(screen.queryByRole("button", { name: "コンパクションモデルのEffort" })).toBeNull();
  });
});
